import { Fragment, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import '../styles/org.css'
import { api } from '../lib/api'
import { MemberPicker } from './masters/DepartmentMaster'
import { useQuery } from '../lib/useQuery'
import { canAdminister, useAuth } from '../lib/auth'
import type { Department, Designation, Team, User, WorkSchedule } from '../lib/types'
import { ErrorNote } from '../components/ui'
import Tabs, { TabPanel, type TabDef } from '../components/Tabs'
import {
  ColumnSettings, FieldSettings, useColumns, useFieldModes,
  type ColumnDef, type FieldDef, type FieldSection,
} from '../components/ViewSettings'

/* ------------------------------------------------------- column catalogues --- */

/** One table's columns. A person picks and orders them from Settings; the ones
 *  without `initial: false` are what each table shows until they do. */
type OrgColumn<T> = ColumnDef & { td: (row: T) => ReactNode; className?: string; thClass?: string; thStyle?: CSSProperties }
const dim = <span className="muted-sm">—</span>

const DEPARTMENT_COLUMNS: OrgColumn<Department>[] = [
  { key: 'department', label: 'Department', locked: true, td: (d) => (
    <>
      <b>{d.name}</b>
      {d.description && <div className="muted-sm">{d.description}</div>}
    </>
  ) },
  { key: 'code', label: 'Code', className: 'muted-sm', td: (d) => d.code ?? '—' },
  { key: 'head', label: 'Head', td: (d) => d.head_name ?? <span className="muted-sm">unassigned</span> },
  { key: 'teams', label: 'Teams', className: 'num', thClass: 'num', td: (d) => d.team_count },
  { key: 'people', label: 'People', className: 'num', thClass: 'num', td: (d) => d.member_count },
  { key: 'status', label: 'Status', initial: false, td: (d) => (d.is_active ? 'Active' : 'Inactive') },
]
const TEAM_COLUMNS: OrgColumn<Team>[] = [
  { key: 'team', label: 'Team', locked: true, td: (t) => (
    <>
      <b>{t.name}</b>
      {t.description && <div className="muted-sm">{t.description}</div>}
    </>
  ) },
  { key: 'department', label: 'Department', td: (t) => t.department_name ?? dim },
  { key: 'manager', label: 'Manager', td: (t) => t.manager_name ?? <span className="muted-sm">unassigned</span> },
  { key: 'members', label: 'Members', className: 'num', thClass: 'num', td: (t) => t.member_count },
  { key: 'status', label: 'Status', initial: false, td: (t) => (t.is_active ? 'Active' : 'Inactive') },
]
const DESIGNATION_COLUMNS: OrgColumn<Designation>[] = [
  { key: 'designation', label: 'Designation', locked: true, td: (d) => <b>{d.name}</b> },
  { key: 'level', label: 'Seniority', className: 'num', td: (d) => d.level },
  { key: 'people', label: 'People', className: 'num', td: (d) => d.member_count },
  { key: 'department', label: 'Department', initial: false, td: (d) => d.department_name ?? 'Any' },
  { key: 'status', label: 'Status', initial: false, td: (d) => (d.is_active ? 'Active' : 'Inactive') },
]
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const SCHEDULE_COLUMNS: OrgColumn<WorkSchedule>[] = [
  { key: 'schedule', label: 'Schedule', locked: true, td: (s) => (
    <>
      <b>{s.name}</b>
      {s.is_default && <span className="badge" style={{ marginLeft: 8 }}>default</span>}
    </>
  ) },
  { key: 'hours', label: 'Hours', td: (s) => <>{s.start_time}–{s.end_time}</> },
  { key: 'days', label: 'Days', className: 'muted-sm', td: (s) => DAYS.filter((_, i) => s.working_days & (1 << i)).join(' ') },
  { key: 'expected', label: 'Expected', className: 'num', thClass: 'num', td: (s) => `${(s.expected_minutes / 60).toFixed(1)} h` },
  { key: 'overtime', label: 'Overtime after', className: 'num', thClass: 'num', td: (s) => `${(s.overtime_after_minutes / 60).toFixed(1)} h` },
  { key: 'people', label: 'People', className: 'num', thClass: 'num', td: (s) => s.member_count },
  { key: 'break', label: 'Unpaid break', initial: false, className: 'num', thClass: 'num', td: (s) => `${s.break_minutes} min` },
]

/* ---------------------------------------------------------- field catalogues --- */

const DEPARTMENT_FIELD_SECTIONS: FieldSection[] = [{ id: 'department', label: 'Department' }]
const DEPARTMENT_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Name', section: 'department', fixed: true },
  { key: 'code', label: 'Code', section: 'department' },
  { key: 'head', label: 'Head of department', section: 'department' },
  { key: 'parent', label: 'Parent department', section: 'department' },
]
const TEAM_FIELD_SECTIONS: FieldSection[] = [{ id: 'team', label: 'Team' }]
const TEAM_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Name', section: 'team', fixed: true },
  { key: 'department', label: 'Department', section: 'team' },
  { key: 'manager', label: 'Manager', section: 'team' },
]
const DESIGNATION_FIELD_SECTIONS: FieldSection[] = [{ id: 'designation', label: 'Designation' }]
const DESIGNATION_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Title', section: 'designation', fixed: true },
  { key: 'level', label: 'Seniority level', section: 'designation', optionalOnly: true },
]
const SCHEDULE_FIELD_SECTIONS: FieldSection[] = [{ id: 'schedule', label: 'Work schedule' }]
const SCHEDULE_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Name', section: 'schedule', fixed: true },
  { key: 'start', label: 'Start', section: 'schedule' },
  { key: 'end', label: 'End', section: 'schedule' },
  { key: 'days', label: 'Working days', section: 'schedule', optionalOnly: true },
  { key: 'break', label: 'Unpaid break (minutes)', section: 'schedule', optionalOnly: true },
  { key: 'overtime', label: 'Overtime after (minutes)', section: 'schedule', optionalOnly: true },
  { key: 'default', label: 'Make this the default', section: 'schedule', optionalOnly: true },
]

/** The mode helpers a form reads its settings through. */
function useOrgFields(formKey: string, defs: FieldDef[], sections: FieldSection[], section: string) {
  const fields = useFieldModes(formKey, defs)
  const fm = fields.mode
  return {
    fm,
    rq: (key: string) => fm(key) === 'mandatory',
    /** The star beside a label whose field is mandatory. */
    star: (key: string) => (fm(key) === 'mandatory' ? <span className="lf-req"> *</span> : null),
    arrange: (nodes: Record<string, ReactNode>) =>
      fields.orderOf(section).map((key) => <Fragment key={key}>{nodes[key]}</Fragment>),
    missing: (empty: Record<string, boolean>) => Object.keys(empty).some((k) => fm(k) === 'mandatory' && empty[k]),
    button: (
      <FieldSettings defs={defs} sections={sections} modes={fields.modes} order={fields.order}
                     onSave={fields.save} onReset={fields.reset} />
    ),
  }
}

type Tab = 'departments' | 'teams' | 'designations' | 'schedules'

export default function OrgStructure({
  sections,
  title = 'Organisation',
}: {
  /** Which tabs to show; all four when absent. */
  sections?: Tab[]
  title?: string
} = {}) {
  const { user } = useAuth()
  const isAdmin = canAdminister(user)
  const [tab, setTab] = useState<Tab>(sections?.[0] ?? 'departments')

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
          <h1 className="page-title">{title}</h1>
          <p className="page-sub">
            Where people sit. The reporting line is separate — set it on the employee.
          </p>
        </div>
      </div>

      {/* Counts on the tab, so "do we even have designations yet" is answered
          before anyone clicks through to find out. */}
      {/* One section means one page — a lone tab is just noise. */}
      {(!sections || sections.length > 1) && <Tabs
        label="Organisation sections"
        items={([
          { id: 'departments', label: 'Departments', badge: departments.data?.length },
          { id: 'teams', label: 'Teams', badge: teams.data?.length },
          { id: 'designations', label: 'Designations', badge: designations.data?.length },
          { id: 'schedules', label: 'Schedules', badge: schedules.data?.length },
        ] as TabDef<Tab>[]).filter((t) => !sections || sections.includes(t.id))}
        value={tab}
        onChange={setTab}
      />}

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
            tableKey="org-departments"
            defs={DEPARTMENT_COLUMNS}
            action={isAdmin ? (d) => (
              <DeleteButton
                label={d.name}
                note="Its teams and employees are kept — they simply become unassigned."
                onDelete={async () => {
                  await api.del(`/org/departments/${d.id}`)
                  reloadAll()
                }}
              />
            ) : () => null}
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
            tableKey="org-teams"
            defs={TEAM_COLUMNS}
            action={isAdmin ? (t) => (
              <DeleteButton
                label={t.name}
                note="Members are kept — they simply become unassigned."
                onDelete={async () => {
                  await api.del(`/org/teams/${t.id}`)
                  reloadAll()
                }}
              />
            ) : () => null}
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
            tableKey="org-designations"
            defs={DESIGNATION_COLUMNS}
            action={isAdmin ? (d) => (
              <DeleteButton
                label={d.name}
                onDelete={async () => {
                  await api.del(`/org/designations/${d.id}`)
                  designations.reload()
                  people.reload()
                }}
              />
            ) : () => null}
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
            tableKey="org-schedules"
            defs={SCHEDULE_COLUMNS}
          />
        </TabPanel>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- helpers --- */

function ListCard<T>({
  rows,
  tableKey,
  defs,
  action,
  error,
  loading,
  empty,
}: {
  rows: T[]
  tableKey: string
  defs: OrgColumn<T>[]
  /** The trailing column (delete), always last and not configurable. */
  action?: (row: T) => ReactNode
  error: string | null
  loading: boolean
  empty: string
}) {
  const columns = useColumns(tableKey, defs)
  if (error) return <ErrorNote>{error}</ErrorNote>
  const visible = columns.visible as OrgColumn<T>[]
  return (
    <section className="card">
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '2px 0 8px' }}>
        <ColumnSettings defs={defs} order={columns.pref.order} hidden={columns.pref.hidden}
                        onSave={columns.save} onReset={columns.reset} />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {visible.map((c) => (
                <th key={c.key} className={c.thClass} style={c.thStyle}>{c.label}</th>
              ))}
              {action && <th className="num" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={(row as { id?: string }).id ?? i}>
                {visible.map((c) => <td key={c.key} className={c.className}>{c.td(row)}</td>)}
                {action && <td className="num">{action(row)}</td>}
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={visible.length + (action ? 1 : 0)} className="empty">{empty}</td>
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
  action,
  settings,
}: {
  title: string
  hint?: string
  onSubmit: (e: FormEvent) => void
  children: React.ReactNode
  busy: boolean
  error: string | null
  submitLabel: string
  /** Extra control on the right of the card's title row. */
  action?: React.ReactNode
  /** The form's field Settings button. */
  settings?: React.ReactNode
}) {
  return (
    <form className="card" style={{ marginBottom: 14 }} onSubmit={onSubmit}>
      <div className="card-head">
        <h2 className="card-title">{title}</h2>
        {(action || settings) && <div className="card-tools" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{settings}{action}</div>}
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

  /** `after` runs once the record exists. Its failure is reported but does not
   *  undo the create — the form still resets, so a retry cannot duplicate it. */
  async function create(
    body: unknown,
    reset: () => void,
    after?: (created: { id: string }) => Promise<void>,
  ) {
    setBusy(true)
    setError(null)
    try {
      const created = await api.post<{ id: string }>(path, body)
      if (after) {
        try {
          await after(created)
        } catch (err) {
          setError(`Saved, but ${err instanceof Error ? err.message : 'the follow-up step failed'}`)
        }
      }
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
  const [memberIds, setMemberIds] = useState<string[]>([])
  const [picking, setPicking] = useState(false)
  const { busy, error, create } = useCreate('/org/departments', onSaved)
  const members = people.filter((p) => memberIds.includes(p.id))
  const of = useOrgFields('org-department-form', DEPARTMENT_FIELDS, DEPARTMENT_FIELD_SECTIONS, 'department')
  const [note, setNote] = useState<string | null>(null)
  const missing = of.missing({ code: form.code.trim() === '', head: !form.head_user_id, parent: !form.parent_id })

  return (
    <FormCard
      title="Add department"
      settings={of.button}
      onSubmit={(e) => {
        e.preventDefault()
        setNote(null)
        if (missing) { setNote('Fill in the fields marked *.'); return }
        void create(
          {
            name: form.name,
            code: form.code || null,
            head_user_id: form.head_user_id || null,
            parent_id: form.parent_id || null,
          },
          () => {
            setForm({ name: '', code: '', head_user_id: '', parent_id: '' })
            setMemberIds([])
          },
          memberIds.length
            ? async (created) => {
                await api.post('/org/assign', { user_ids: memberIds, department_id: created.id })
              }
            : undefined,
        )
      }}
      busy={busy}
      error={note ?? error}
      submitLabel="Create department"
      action={
        <button type="button" className="btn btn-primary" onClick={() => setPicking(true)}>
          Add employees
        </button>
      }
    >
      {of.arrange({
        name: (
          <label className="setting">
            Name <span className="lf-req"> *</span>
            <input placeholder="e.g. Engineering" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </label>
        ),
        code: of.fm('code') !== 'hide' && (
          <label className="setting">
            Code{of.star('code')}
            <input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              placeholder="ENG"
            />
          </label>
        ),
        head: of.fm('head') !== 'hide' && (
          <label className="setting">
            Head of department{of.star('head')}
            <select value={form.head_user_id} onChange={(e) => setForm({ ...form, head_user_id: e.target.value })}>
              <option value="">Unassigned</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.full_name}</option>
              ))}
            </select>
            <span className="setting-hint">Heads can see everyone in the department.</span>
          </label>
        ),
        parent: of.fm('parent') !== 'hide' && (
          <label className="setting">
            Parent department{of.star('parent')}
            <select value={form.parent_id} onChange={(e) => setForm({ ...form, parent_id: e.target.value })}>
              <option value="">None — top level</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </label>
        ),
      })}
      {members.length > 0 && (
        <div className="setting">
          <span>Employees ({members.length})</span>
          <span className="setting-hint">{members.map((p) => p.full_name).join(', ')}</span>
        </div>
      )}
      {picking && (
        <MemberPicker
          people={people}
          initial={memberIds}
          onClose={() => setPicking(false)}
          onDone={(ids) => {
            setMemberIds(ids)
            setPicking(false)
          }}
        />
      )}
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
  const of = useOrgFields('org-team-form', TEAM_FIELDS, TEAM_FIELD_SECTIONS, 'team')
  const [note, setNote] = useState<string | null>(null)
  const missing = of.missing({ department: !form.department_id, manager: !form.manager_user_id })

  return (
    <FormCard
      title="Add team"
      settings={of.button}
      onSubmit={(e) => {
        e.preventDefault()
        setNote(null)
        if (missing) { setNote('Fill in the fields marked *.'); return }
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
      error={note ?? error}
      submitLabel="Create team"
    >
      {of.arrange({
        name: (
          <label className="setting">
            Name <span className="lf-req"> *</span>
            <input placeholder="e.g. Backend Team" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </label>
        ),
        department: of.fm('department') !== 'hide' && (
          <label className="setting">
            Department{of.star('department')}
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
        ),
        manager: of.fm('manager') !== 'hide' && (
          <label className="setting">
            Manager{of.star('manager')}
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
        ),
      })}
    </FormCard>
  )
}

function DesignationForm({ onSaved }: { onSaved: () => void }) {
  const [form, setForm] = useState({ name: '', level: 1 })
  const { busy, error, create } = useCreate('/org/designations', onSaved)
  const of = useOrgFields('org-designation-form', DESIGNATION_FIELDS, DESIGNATION_FIELD_SECTIONS, 'designation')

  return (
    <FormCard
      title="Add designation"
      settings={of.button}
      hint="Seniority orders people in reports. Level 1 is the most senior."
      onSubmit={(e) => {
        e.preventDefault()
        void create(form, () => setForm({ name: '', level: 1 }))
      }}
      busy={busy}
      error={error}
      submitLabel="Create designation"
    >
      {of.arrange({
        name: (
          <label className="setting">
            Title <span className="lf-req"> *</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Senior Engineer"
              required
            />
          </label>
        ),
        level: of.fm('level') !== 'hide' && (
          <label className="setting">
            Seniority level
            <input placeholder="e.g. 3"
              type="number"
              min={1}
              max={100}
              value={form.level}
              onChange={(e) => setForm({ ...form, level: Number(e.target.value) })}
            />
          </label>
        ),
      })}
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
  const of = useOrgFields('org-schedule-form', SCHEDULE_FIELDS, SCHEDULE_FIELD_SECTIONS, 'schedule')
  const [note, setNote] = useState<string | null>(null)
  const missing = of.missing({ start: !form.start_time, end: !form.end_time })

  function toggleDay(index: number) {
    setForm((f) => ({ ...f, working_days: f.working_days ^ (1 << index) }))
  }

  return (
    <FormCard
      title="Add work schedule"
      settings={of.button}
      hint="Expected hours drive attendance and overtime. A support team on 10:00–19:00 and engineering on 09:30–18:30 is the normal case."
      onSubmit={(e) => {
        e.preventDefault()
        setNote(null)
        if (missing) { setNote('Fill in the fields marked *.'); return }
        void create(form, () =>
          setForm({ ...form, name: '', is_default: false }),
        )
      }}
      busy={busy}
      error={note ?? error}
      submitLabel="Create schedule"
    >
      {of.arrange({
        name: (
          <label className="setting">
            Name <span className="lf-req"> *</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Engineering 09:30"
              required
            />
          </label>
        ),
        start: of.fm('start') !== 'hide' && (
          <label className="setting">
            Start{of.star('start')}
            <input type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} />
          </label>
        ),
        end: of.fm('end') !== 'hide' && (
          <label className="setting">
            End{of.star('end')}
            <input type="time" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} />
          </label>
        ),
        days: of.fm('days') !== 'hide' && (
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
        ),
        break: of.fm('break') !== 'hide' && (
          <label className="setting">
            Unpaid break (minutes)
            <input placeholder="60"
              type="number"
              min={0}
              max={480}
              value={form.break_minutes}
              onChange={(e) => setForm({ ...form, break_minutes: Number(e.target.value) })}
            />
          </label>
        ),
        overtime: of.fm('overtime') !== 'hide' && (
          <label className="setting">
            Overtime after (minutes)
            <input placeholder="540"
              type="number"
              min={60}
              max={1440}
              step={30}
              value={form.overtime_after_minutes}
              onChange={(e) => setForm({ ...form, overtime_after_minutes: Number(e.target.value) })}
            />
          </label>
        ),
        default: of.fm('default') !== 'hide' && (
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
        ),
      })}
    </FormCard>
  )
}
