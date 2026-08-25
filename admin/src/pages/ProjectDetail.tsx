import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import '../styles/projects.css'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { canAdminister, useAuth } from '../lib/auth'
import { duration } from '../lib/format'
import type { Project, ProjectMember, ProjectRule, Task, User } from '../lib/types'
import { Loading, ErrorNote, StatTile } from '../components/ui'
import Tabs, { TabPanel } from '../components/Tabs'
import { ProjectStatusPill, rupees } from './Projects'

type Tab = 'tasks' | 'members' | 'rules'

const TASK_COLUMNS: Array<{ id: Task['status']; label: string }> = [
  { id: 'todo', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' },
]

export default function ProjectDetail() {
  const { projectId = '' } = useParams()
  const { user } = useAuth()
  const isAdmin = canAdminister(user)
  const [tab, setTab] = useState<Tab>('tasks')

  // The list endpoint carries the rollups (tracked, billable, counts) that a
  // single-project GET would have to recompute, so the detail page reads from
  // it and filters rather than adding a second aggregation path.
  const projects = useQuery<Project[]>('projects:true', () =>
    api.get<Project[]>('/projects?include_archived=true'),
  )
  const tasks = useQuery<Task[]>(`tasks:${projectId}`, () =>
    api.get<Task[]>(`/projects/${projectId}/tasks`),
  )
  const members = useQuery<ProjectMember[]>(`members:${projectId}`, () =>
    api.get<ProjectMember[]>(`/projects/${projectId}/members`),
  )
  const rules = useQuery<ProjectRule[]>('project-rules', () =>
    api.get<ProjectRule[]>('/projects/rules/all'),
  )

  if (projects.error) return <ErrorNote>{projects.error}</ErrorNote>
  if (projects.loading || !projects.data) return <Loading />

  const project = projects.data.find((p) => p.id === projectId)
  if (!project) return <ErrorNote>That project no longer exists.</ErrorNote>

  const myRules = (rules.data ?? []).filter((r) => r.project_id === projectId)
  const budgetPct = project.budget_minutes
    ? Math.round((project.tracked_seconds / 60 / project.budget_minutes) * 100)
    : null
  const billableValue = Math.round((project.billable_seconds / 3600) * project.hourly_rate)

  return (
    <div>
      <div className="page-head">
        <div>
          <Link className="pj-back" to="/projects">← All projects</Link>
          <h1 className="page-title">
            <span
              className="pj-swatch"
              style={{ background: project.color || 'var(--brand)', marginRight: 10 }}
              aria-hidden="true"
            />
            {project.name}
          </h1>
          <p className="page-sub">
            {[project.code, project.client_name, project.manager_name].filter(Boolean).join(' · ') ||
              'No client or manager set'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <ProjectStatusPill value={project.status} />
          {!project.is_billable && <span className="pj-pill pj-nonbillable">Non-billable</span>}
        </div>
      </div>

      <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
        <StatTile label="Tracked" value={duration(project.tracked_seconds)} />
        <StatTile label="Billable" value={duration(project.billable_seconds)} accent="var(--prod)" />
        <StatTile
          label="Billable value"
          value={rupees(billableValue)}
          meta={project.hourly_rate ? `at ${rupees(project.hourly_rate)}/h` : 'no rate set'}
        />
        <StatTile
          label="Budget used"
          value={budgetPct === null ? '—' : `${budgetPct}%`}
          meta={
            project.budget_minutes
              ? `${Math.round(project.budget_minutes / 60)}h budgeted`
              : 'no budget set'
          }
          accent={budgetPct !== null && budgetPct > 100 ? 'var(--unprod)' : undefined}
        />
        <StatTile label="Team" value={String(project.member_count)} meta="assigned" />
      </div>

      {/* The counts were parenthetical inside the label — "Tasks (3/12)" reads
          as one long word at a glance. As badges they are the scannable part. */}
      <Tabs
        label="Project sections"
        items={[
          { id: 'tasks', label: 'Tasks', badge: `${project.open_task_count}/${project.task_count}` },
          { id: 'members', label: 'Members', badge: project.member_count },
          { id: 'rules', label: 'Attribution rules', badge: myRules.length },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'tasks' && (
        <TabPanel id="tasks">
          <TasksBoard
            projectId={projectId}
            tasks={tasks.data ?? []}
            loading={tasks.loading}
            onChanged={() => { tasks.reload(); projects.reload() }}
          />
        </TabPanel>
      )}

      {tab === 'members' && (
        <TabPanel id="members">
          <MembersPanel
            projectId={projectId}
            members={members.data ?? []}
            isAdmin={isAdmin}
            onChanged={() => { members.reload(); projects.reload() }}
          />
        </TabPanel>
      )}

      {tab === 'rules' && (
        <TabPanel id="rules">
          <RulesPanel
            projectId={projectId}
            rules={myRules}
            tasks={tasks.data ?? []}
            isAdmin={isAdmin}
            onChanged={() => rules.reload()}
          />
        </TabPanel>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- tasks --- */

function TasksBoard({
  projectId,
  tasks,
  loading,
  onChanged,
}: {
  projectId: string
  tasks: Task[]
  loading: boolean
  onChanged: () => void
}) {
  const [adding, setAdding] = useState(false)

  async function move(task: Task, status: Task['status']) {
    await api.patch(`/projects/${projectId}/tasks/${task.id}`, {
      title: task.title,
      description: task.description,
      status,
      assignee_user_id: task.assignee_user_id,
      estimate_hours: task.estimate_minutes / 60,
      due_on: task.due_on,
      is_billable: task.is_billable,
    })
    onChanged()
  }

  return (
    <>
      <div className="filter-row">
        <button className="btn btn-primary btn-sm" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'Add task'}
        </button>
      </div>

      {adding && (
        <NewTask projectId={projectId} onDone={() => { setAdding(false); onChanged() }} />
      )}

      {loading ? (
        <Loading />
      ) : (
        <div className="pj-board">
          {TASK_COLUMNS.map((column) => {
            const items = tasks.filter((t) => t.status === column.id)
            return (
              <section className="pj-column" key={column.id}>
                <header className="pj-column-head">
                  {column.label}
                  <span className="pj-count">{items.length}</span>
                </header>
                {items.map((task) => (
                  <article className="pj-task" key={task.id}>
                    <div className="pj-task-title">{task.title}</div>
                    <div className="pj-task-meta">
                      {task.assignee_name ?? 'Unassigned'}
                      {task.estimate_minutes > 0 && ` · est ${Math.round(task.estimate_minutes / 60)}h`}
                    </div>
                    {task.tracked_seconds > 0 && (
                      <div className="pj-task-tracked">
                        {duration(task.tracked_seconds)} tracked
                        {task.estimate_minutes > 0 && (
                          <span
                            className={
                              task.tracked_seconds / 60 > task.estimate_minutes
                                ? 'pj-over'
                                : undefined
                            }
                          >
                            {' '}
                            ({Math.round((task.tracked_seconds / 60 / task.estimate_minutes) * 100)}%
                            of estimate)
                          </span>
                        )}
                      </div>
                    )}
                    {/* A select, not drag-and-drop: it is keyboard-reachable,
                        works on touch, and never loses a card to a mis-drop. */}
                    <select
                      className="pj-task-move"
                      value={task.status}
                      onChange={(e) => void move(task, e.target.value as Task['status'])}
                      aria-label={`Move ${task.title}`}
                    >
                      {TASK_COLUMNS.map((c) => (
                        <option key={c.id} value={c.id}>{c.label}</option>
                      ))}
                    </select>
                  </article>
                ))}
                {items.length === 0 && <p className="pj-column-empty">Nothing here</p>}
              </section>
            )
          })}
        </div>
      )}
    </>
  )
}

function NewTask({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [form, setForm] = useState({
    title: '',
    status: 'todo',
    assignee_user_id: '',
    estimate_hours: 0,
    due_on: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const people = useQuery<User[]>('employees', () => api.get<User[]>('/admin/employees'))

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post(`/projects/${projectId}/tasks`, {
        ...form,
        assignee_user_id: form.assignee_user_id || null,
        due_on: form.due_on || null,
      })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the task')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" style={{ marginBottom: 14 }} onSubmit={submit}>
      {error && <div style={{ marginBottom: 12 }}><ErrorNote>{error}</ErrorNote></div>}
      <div className="settings-grid">
        <label className="setting">
          Title
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required autoFocus />
        </label>
        <label className="setting">
          Assignee
          <select value={form.assignee_user_id} onChange={(e) => setForm({ ...form, assignee_user_id: e.target.value })}>
            <option value="">Unassigned</option>
            {people.data?.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        </label>
        <label className="setting">
          Estimate (hours)
          <input
            type="number"
            min={0}
            step={0.5}
            value={form.estimate_hours}
            onChange={(e) => setForm({ ...form, estimate_hours: Number(e.target.value) })}
          />
        </label>
        <label className="setting">
          Due
          <input type="date" value={form.due_on} onChange={(e) => setForm({ ...form, due_on: e.target.value })} />
        </label>
      </div>
      <div style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add task'}</button>
      </div>
    </form>
  )
}

/* -------------------------------------------------------------- members --- */

function MembersPanel({
  projectId,
  members,
  isAdmin,
  onChanged,
}: {
  projectId: string
  members: ProjectMember[]
  isAdmin: boolean
  onChanged: () => void
}) {
  const [userId, setUserId] = useState('')
  const [role, setRole] = useState('member')
  const [rate, setRate] = useState(0)
  const [busy, setBusy] = useState(false)
  const people = useQuery<User[]>('employees', () => api.get<User[]>('/admin/employees'))

  const assigned = new Set(members.map((m) => m.user_id))
  const available = (people.data ?? []).filter((p) => !assigned.has(p.id))

  async function add(event: FormEvent) {
    event.preventDefault()
    if (!userId) return
    setBusy(true)
    try {
      await api.post(`/projects/${projectId}/members`, {
        user_id: userId,
        role,
        hourly_rate_rupees: rate,
      })
      setUserId('')
      setRate(0)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {isAdmin && (
        <form className="card" style={{ marginBottom: 14 }} onSubmit={add}>
          <div className="card-head"><h2 className="card-title">Assign someone</h2></div>
          <div className="filter-row" style={{ marginBottom: 0 }}>
            <select value={userId} onChange={(e) => setUserId(e.target.value)} style={{ minWidth: 200 }}>
              <option value="">Choose an employee…</option>
              {available.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
            </select>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">Member</option>
              <option value="lead">Lead</option>
            </select>
            <label className="field">
              Rate override ₹/h
              <input
                type="number"
                min={0}
                step={50}
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
                style={{ width: 110 }}
              />
            </label>
            <button className="btn btn-primary btn-sm" disabled={busy || !userId}>Assign</button>
          </div>
          <p className="setting-hint" style={{ marginTop: 10 }}>
            A rate of 0 means this person bills at the project rate.
          </p>
        </form>
      )}

      <section className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Role</th><th className="num">Rate</th>
                <th className="num">Tracked</th><th />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Link className="row-link" to={`/employees/${m.user_id}`}>{m.full_name}</Link>
                    <div className="muted-sm">{m.email}</div>
                  </td>
                  <td>{m.role === 'lead' ? <span className="pj-pill pj-active">Lead</span> : 'Member'}</td>
                  <td className="num">{m.hourly_rate ? rupees(m.hourly_rate) : <span className="muted-sm">project rate</span>}</td>
                  <td className="num">{duration(m.tracked_seconds)}</td>
                  <td className="num">
                    {isAdmin && (
                      <button
                        className="btn btn-sm"
                        onClick={async () => {
                          // Removing a member does not unassign their recorded
                          // time — the hours stay on the project, which is what
                          // any invoice already raised depends on.
                          if (!window.confirm(`Remove ${m.full_name} from this project?\n\nTheir tracked hours stay on the project.`)) return
                          await api.del(`/projects/${projectId}/members/${m.user_id}`)
                          onChanged()
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {members.length === 0 && (
                <tr><td colSpan={5} className="empty">Nobody assigned yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

/* ---------------------------------------------------------------- rules --- */

const MATCH_HINTS: Record<string, string> = {
  domain: 'A website host, e.g. github.com. Subdomains match too.',
  app: 'An executable name, e.g. code.exe.',
  title: 'Any text appearing in the window title.',
  repo: 'A git repository name, reported by the agent for developer work.',
}

function RulesPanel({
  projectId,
  rules,
  tasks,
  isAdmin,
  onChanged,
}: {
  projectId: string
  rules: ProjectRule[]
  tasks: Task[]
  isAdmin: boolean
  onChanged: () => void
}) {
  const [form, setForm] = useState({ match_type: 'domain', pattern: '', task_id: '', priority: 0 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function add(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/projects/rules', {
        project_id: projectId,
        task_id: form.task_id || null,
        match_type: form.match_type,
        pattern: form.pattern.trim(),
        priority: form.priority,
      })
      setForm({ ...form, pattern: '' })
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the rule')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="notice" style={{ marginBottom: 14 }}>
        Rules attribute time automatically. They never override an assignment a person made by
        hand, or a project the employee selected in the agent — those always win.
      </div>

      {isAdmin && (
        <form className="card" style={{ marginBottom: 14 }} onSubmit={add}>
          <div className="card-head"><h2 className="card-title">Add rule</h2></div>
          {error && <div style={{ marginBottom: 12 }}><ErrorNote>{error}</ErrorNote></div>}
          <div className="filter-row" style={{ marginBottom: 0 }}>
            <select
              value={form.match_type}
              onChange={(e) => setForm({ ...form, match_type: e.target.value })}
            >
              <option value="domain">Website domain</option>
              <option value="app">Application</option>
              <option value="title">Window title contains</option>
              <option value="repo">Git repository</option>
            </select>
            <input
              value={form.pattern}
              onChange={(e) => setForm({ ...form, pattern: e.target.value })}
              placeholder={form.match_type === 'app' ? 'code.exe' : 'github.com'}
              style={{ minWidth: 200 }}
              required
            />
            <select value={form.task_id} onChange={(e) => setForm({ ...form, task_id: e.target.value })}>
              <option value="">Whole project</option>
              {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
            <button className="btn btn-primary btn-sm" disabled={busy}>Add rule</button>
          </div>
          <p className="setting-hint" style={{ marginTop: 10 }}>{MATCH_HINTS[form.match_type]}</p>
        </form>
      )}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Rules</h2>
          {isAdmin && (
            <button
              className="btn btn-sm"
              onClick={async () => {
                const result = await api.post<{ scanned: number; changed: number }>(
                  '/projects/reattribute?days=30',
                )
                setNotice(
                  `Re-checked ${result.scanned} entries from the last 30 days; ${result.changed} moved. Manual assignments were left alone.`,
                )
                onChanged()
              }}
            >
              Apply to last 30 days
            </button>
          )}
        </div>
        {notice && <div className="notice" style={{ marginBottom: 12 }}>{notice}</div>}
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Type</th><th>Pattern</th><th>Applies to</th><th className="num">Priority</th><th /></tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td style={{ color: 'var(--text-secondary)' }}>{rule.match_type}</td>
                  <td><span className="key-chip">{rule.pattern}</span></td>
                  <td className="muted-sm">
                    {rule.task_id
                      ? tasks.find((t) => t.id === rule.task_id)?.title ?? 'a task'
                      : 'Whole project'}
                  </td>
                  <td className="num">{rule.priority}</td>
                  <td className="num">
                    {isAdmin && (
                      <button
                        className="btn btn-sm"
                        onClick={async () => {
                          await api.del(`/projects/rules/${rule.id}`)
                          onChanged()
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {rules.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    No rules yet. Without one, time only lands here if someone assigns it.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
