import { useState, type FormEvent } from 'react'
import '../styles/org.css'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { canAdminister, useAuth } from '../lib/auth'
import type { Department, Designation, Team, User, WorkSchedule } from '../lib/types'
import { ErrorNote } from '../components/ui'
import Tabs, { TabPanel } from '../components/Tabs'

type Tab = 'departments' | 'teams' | 'designations' | 'schedules'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export default function OrgStructure() {
  const { user } = useAuth()
  const isAdmin = canAdminister(user)
  const [tab, setTab] = useState<Tab>('departments')

  const departments = useQuery<Department[]>('departments', () =>
    api.get<Department[]>('/org/departments'),
  )
  const teams = useQuery<Team[]>('teams', () => api.get<Team[]>('/org/teams'))
  const designations = useQuery<Designation[]>('designations', () =>
    api.get<Designation[]>('/org/designations'),
  )
  const schedules = useQuery<WorkSchedule[]>('schedules', () =>
    api.get<WorkSchedule[]>('/org/schedules'),
  )
  const people = useQuery<User[]>('employees', () => api.get<User[]>('/admin/employees'))

  const reloadAll = () => {
    departments.reload()
    teams.reload()
    people.reload()
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Organisation</h1>
          <p className="page-sub">
            Where people sit. The reporting line is separate — set it on the employee.
          </p>
        </div>
      </div>

      {/* Counts on the tab, so "do we even have designations yet" is answered
          before anyone clicks through to find out. */}
      <Tabs
        label="Organisation sections"
        items={[
          { id: 'departments', label: 'Departments', badge: departments.data?.length },
          { id: 'teams', label: 'Teams', badge: teams.data?.length },
          { id: 'designations', label: 'Designations', badge: designations.data?.length },
          { id: 'schedules', label: 'Schedules', badge: schedules.data?.length },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'departments' && (
        <TabPanel id="departments">
          {isAdmin && (
            <DepartmentForm
              people={people.data ?? []}
              departments={departments.data ?? []}
              onSaved={reloadAll}
            />
          )}
          <ListCard
            error={departments.error}
            loading={departments.loading}
            empty="No departments yet."
            rows={departments.data ?? []}
            columns={['Department', 'Code', 'Head', 'Teams', 'People', '']}
            render={(d) => (
              <tr key={d.id}>
                <td>
                  <b>{d.name}</b>
                  {d.description && <div className="muted-sm">{d.description}</div>}
                </td>
                <td className="muted-sm">{d.code ?? '—'}</td>
                <td>{d.head_name ?? <span className="muted-sm">unassigned</span>}</td>
                <td className="num">{d.team_count}</td>
                <td className="num">{d.member_count}</td>
                <td className="num">
                  {isAdmin && (
                    <DeleteButton
                      label={d.name}
                      note="Its teams and employees are kept — they simply become unassigned."
                      onDelete={async () => {
                        await api.del(`/org/departments/${d.id}`)
                        reloadAll()
                      }}
                    />
                  )}
                </td>
              </tr>
            )}
          />
        </TabPanel>
      )}

      {tab === 'teams' && (
        <TabPanel id="teams">
          {isAdmin && (
            <TeamForm
              departments={departments.data ?? []}
              people={people.data ?? []}
              onSaved={reloadAll}
            />
          )}
          <ListCard
            error={teams.error}
            loading={teams.loading}
            empty="No teams yet."
            rows={teams.data ?? []}
            columns={['Team', 'Department', 'Manager', 'Members', '']}
            render={(t) => (
              <tr key={t.id}>
                <td>
                  <b>{t.name}</b>
                  {t.description && <div className="muted-sm">{t.description}</div>}
                </td>
                <td>{t.department_name ?? <span className="muted-sm">—</span>}</td>
                <td>
                  {t.manager_name ?? <span className="muted-sm">unassigned</span>}
                </td>
                <td className="num">{t.member_count}</td>
                <td className="num">
                  {isAdmin && (
                    <DeleteButton
                      label={t.name}
                      note="Members are kept — they simply become unassigned."
                      onDelete={async () => {
                        await api.del(`/org/teams/${t.id}`)
                        reloadAll()
                      }}
                    />
                  )}
                </td>
              </tr>
            )}
          />
        </TabPanel>
      )}

      {tab === 'designations' && (
        <TabPanel id="designations">
          {isAdmin && <DesignationForm onSaved={() => designations.reload()} />}
          <ListCard
            error={designations.error}
            loading={designations.loading}
            empty="No designations yet."
            rows={designations.data ?? []}
            columns={['Designation', 'Seniority', 'People', '']}
            render={(d) => (
              <tr key={d.id}>
                <td><b>{d.name}</b></td>
                <td className="num">{d.level}</td>
                <td className="num">{d.member_count}</td>
                <td className="num">
                  {isAdmin && (
                    <DeleteButton
                      label={d.name}
                      onDelete={async () => {
                        await api.del(`/org/designations/${d.id}`)
                        designations.reload()
                        people.reload()
                      }}
                    />
                  )}
                </td>
              </tr>
            )}
          />
        </TabPanel>
      )}

      {tab === 'schedules' && (
        <TabPanel id="schedules">
          {isAdmin && <ScheduleForm onSaved={() => schedules.reload()} />}
          <ListCard
            error={schedules.error}
            loading={schedules.loading}
            empty="No schedules yet. Employees fall back to the organisation's working hours."
            rows={schedules.data ?? []}
            columns={['Schedule', 'Hours', 'Days', 'Expected', 'Overtime after', 'People']}
            render={(s) => (
              <tr key={s.id}>
                <td>
                  <b>{s.name}</b>
                  {s.is_default && <span className="badge" style={{ marginLeft: 8 }}>default</span>}
                </td>
                <td>{s.start_time}–{s.end_time}</td>
                <td className="muted-sm">
                  {DAYS.filter((_, i) => s.working_days & (1 << i)).join(' ')}
                </td>
                <td className="num">{(s.expected_minutes / 60).toFixed(1)} h</td>
                <td className="num">{(s.overtime_after_minutes / 60).toFixed(1)} h</td>
                <td className="num">{s.member_count}</td>
              </tr>
            )}
          />
        </TabPanel>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- helpers --- */

function ListCard<T>({
  rows,
  columns,
  render,
  error,
  loading,
  empty,
}: {
  rows: T[]
  columns: string[]
  render: (row: T) => React.ReactNode
  error: string | null
  loading: boolean
  empty: string
}) {
  if (error) return <ErrorNote>{error}</ErrorNote>
  return (
    <section className="card">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={c || i} className={i >= 3 ? 'num' : undefined}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(render)}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="empty">{empty}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function DeleteButton({
  label,
  note,
  onDelete,
}: {
  label: string
  note?: string
  onDelete: () => Promise<void>
}) {
  return (
    <button
      className="btn btn-sm"
      onClick={() => {
        // Deleting structure is reversible in effect (nothing cascades to
        // people), so a confirm is enough — no typed-name gate.
        if (window.confirm(`Delete “${label}”?${note ? `\n\n${note}` : ''}`)) void onDelete()
      }}
    >
      Delete
    </button>
  )
}

function FormCard({
  title,
  hint,
  onSubmit,
  children,
  busy,
  error,
  submitLabel,
}: {
  title: string
  hint?: string
  onSubmit: (e: FormEvent) => void
  children: React.ReactNode
  busy: boolean
  error: string | null
  submitLabel: string
}) {
  return (
    <form className="card" style={{ marginBottom: 14 }} onSubmit={onSubmit}>
      <div className="card-head">
        <h2 className="card-title">{title}</h2>
      </div>
      {hint && <p className="setting-hint" style={{ marginTop: -8, marginBottom: 12 }}>{hint}</p>}
      {error && <div style={{ marginBottom: 12 }}><ErrorNote>{error}</ErrorNote></div>}
      <div className="settings-grid">{children}</div>
      <div style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  )
}

function useCreate(path: string, onSaved: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create(body: unknown, reset: () => void) {
    setBusy(true)
    setError(null)
    try {
      await api.post(path, body)
      reset()
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, create }
}

/* --------------------------------------------------------------- forms --- */

function DepartmentForm({
  people,
  departments,
  onSaved,
}: {
  people: User[]
  departments: Department[]
  onSaved: () => void
}) {
  const [form, setForm] = useState({ name: '', code: '', head_user_id: '', parent_id: '' })
  const { busy, error, create } = useCreate('/org/departments', onSaved)

  return (
    <FormCard
      title="Add department"
      onSubmit={(e) => {
        e.preventDefault()
        void create(
          {
            name: form.name,
            code: form.code || null,
            head_user_id: form.head_user_id || null,
            parent_id: form.parent_id || null,
          },
          () => setForm({ name: '', code: '', head_user_id: '', parent_id: '' }),
        )
      }}
      busy={busy}
      error={error}
      submitLabel="Create department"
    >
      <label className="setting">
        Name
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
      </label>
      <label className="setting">
        Code
        <input
          value={form.code}
          onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
          placeholder="ENG"
        />
      </label>
      <label className="setting">
        Head of department
        <select value={form.head_user_id} onChange={(e) => setForm({ ...form, head_user_id: e.target.value })}>
          <option value="">Unassigned</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>{p.full_name}</option>
          ))}
        </select>
        <span className="setting-hint">Heads can see everyone in the department.</span>
      </label>
      <label className="setting">
        Parent department
        <select value={form.parent_id} onChange={(e) => setForm({ ...form, parent_id: e.target.value })}>
          <option value="">None — top level</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </label>
    </FormCard>
  )
}

function TeamForm({
  departments,
  people,
  onSaved,
}: {
  departments: Department[]
  people: User[]
  onSaved: () => void
}) {
  const [form, setForm] = useState({ name: '', department_id: '', manager_user_id: '' })
  const { busy, error, create } = useCreate('/org/teams', onSaved)

  return (
    <FormCard
      title="Add team"
      onSubmit={(e) => {
        e.preventDefault()
        void create(
          {
            name: form.name,
            department_id: form.department_id || null,
            manager_user_id: form.manager_user_id || null,
          },
          () => setForm({ name: '', department_id: '', manager_user_id: '' }),
        )
      }}
      busy={busy}
      error={error}
      submitLabel="Create team"
    >
      <label className="setting">
        Name
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
      </label>
      <label className="setting">
        Department
        <select
          value={form.department_id}
          onChange={(e) => setForm({ ...form, department_id: e.target.value })}
        >
          <option value="">None</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </label>
      <label className="setting">
        Manager
        <select
          value={form.manager_user_id}
          onChange={(e) => setForm({ ...form, manager_user_id: e.target.value })}
        >
          <option value="">Unassigned</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>{p.full_name}</option>
          ))}
        </select>
        <span className="setting-hint">
          Promoted to the manager role automatically, so they can actually open the team.
        </span>
      </label>
    </FormCard>
  )
}

function DesignationForm({ onSaved }: { onSaved: () => void }) {
  const [form, setForm] = useState({ name: '', level: 20 })
  const { busy, error, create } = useCreate('/org/designations', onSaved)

  return (
    <FormCard
      title="Add designation"
      hint="Seniority orders people in reports. Higher is more senior."
      onSubmit={(e) => {
        e.preventDefault()
        void create(form, () => setForm({ name: '', level: 20 }))
      }}
      busy={busy}
      error={error}
      submitLabel="Create designation"
    >
      <label className="setting">
        Title
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Senior Engineer"
          required
        />
      </label>
      <label className="setting">
        Seniority level
        <input
          type="number"
          min={0}
          max={100}
          value={form.level}
          onChange={(e) => setForm({ ...form, level: Number(e.target.value) })}
        />
      </label>
    </FormCard>
  )
}

function ScheduleForm({ onSaved }: { onSaved: () => void }) {
  const [form, setForm] = useState({
    name: '',
    start_time: '09:00',
    end_time: '18:00',
    working_days: 0b0011111,
    break_minutes: 60,
    overtime_after_minutes: 480,
    is_default: false,
  })
  const { busy, error, create } = useCreate('/org/schedules', onSaved)

  function toggleDay(index: number) {
    setForm((f) => ({ ...f, working_days: f.working_days ^ (1 << index) }))
  }

  return (
    <FormCard
      title="Add work schedule"
      hint="Expected hours drive attendance and overtime. A support team on 10:00–19:00 and engineering on 09:30–18:30 is the normal case."
      onSubmit={(e) => {
        e.preventDefault()
        void create(form, () =>
          setForm({ ...form, name: '', is_default: false }),
        )
      }}
      busy={busy}
      error={error}
      submitLabel="Create schedule"
    >
      <label className="setting">
        Name
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Engineering 09:30"
          required
        />
      </label>
      <label className="setting">
        Start
        <input type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} />
      </label>
      <label className="setting">
        End
        <input type="time" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} />
      </label>
      <div className="setting">
        <span>Working days</span>
        <div className="day-picker">
          {DAYS.map((day, index) => (
            <button
              type="button"
              key={day}
              className={`day-chip ${form.working_days & (1 << index) ? 'day-on' : ''}`}
              onClick={() => toggleDay(index)}
              aria-pressed={Boolean(form.working_days & (1 << index))}
            >
              {day}
            </button>
          ))}
        </div>
      </div>
      <label className="setting">
        Unpaid break (minutes)
        <input
          type="number"
          min={0}
          max={480}
          value={form.break_minutes}
          onChange={(e) => setForm({ ...form, break_minutes: Number(e.target.value) })}
        />
      </label>
      <label className="setting">
        Overtime after (minutes)
        <input
          type="number"
          min={60}
          max={1440}
          step={30}
          value={form.overtime_after_minutes}
          onChange={(e) => setForm({ ...form, overtime_after_minutes: Number(e.target.value) })}
        />
      </label>
      <div className="setting">
        <label className="switch-row">
          <input
            type="checkbox"
            checked={form.is_default}
            onChange={(e) => setForm({ ...form, is_default: e.target.checked })}
          />
          <span>Make this the default</span>
        </label>
        <span className="setting-hint">Only one schedule can be the default.</span>
      </div>
    </FormCard>
  )
}
