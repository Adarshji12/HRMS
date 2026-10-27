/* Department Master — the Organisation Master's department list, laid out like
 * the other masters: one card, search and the add button in its head, and
 * edit / delete as icons on the row.
 *
 * Membership is edited from the same dialog as the department itself. The
 * picker starts on whoever is in the department now, so ticking adds people
 * and unticking takes them out; both go through /org/assign once the
 * department is saved.
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import '../../styles/crm.css'
import '../../styles/org.css'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { canAdminister, useAuth } from '../../lib/auth'
import type { Department, User } from '../../lib/types'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconBuilding, IconEdit, IconPlus, IconSearch, IconTrash } from '../../components/Icons'
import { Dialog, Field } from '../crm/parts'
import { MasterTrail } from './MasterBack'

const ORG_TRAIL_DEPARTMENT = [
  { label: 'Master', to: '/masters' },
  { label: 'Organisation Master', to: '/masters' },
  { label: 'Department' },
]

export default function DepartmentMaster() {
  const { user } = useAuth()
  const isAdmin = canAdminister(user)
  const departments = useQuery<Department[]>('departments', () =>
    api.get<Department[]>('/org/departments'),
  )
  const people = useQuery<User[]>('employees', () => api.get<User[]>('/admin/employees'))
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Department | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (departments.data ?? []).filter(
      (d) =>
        !needle ||
        d.name.toLowerCase().includes(needle) ||
        (d.code ?? '').toLowerCase().includes(needle),
    )
  }, [departments.data, q])

  const reloadAll = () => {
    departments.reload()
    people.reload()
  }

  async function remove(department: Department) {
    // Nothing cascades to people — they become unassigned — so a confirm is
    // enough, the same call the Organisation page makes.
    if (!window.confirm(`Delete “${department.name}”?\n\nIts employees are kept — they simply become unassigned.`)) return
    setError(null)
    try {
      await api.del(`/org/departments/${department.id}`)
      reloadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That department could not be deleted')
    }
  }

  const total = departments.data?.length ?? 0

  return (
    <div className="crm">
      <MasterTrail crumbs={ORG_TRAIL_DEPARTMENT} />
      <section className="card dm-card">
        <div className="dm-head">
          <span className="dm-tile"><IconBuilding size={18} /></span>
          <div className="dm-heading">
            <h1 className="dm-title">Department Master</h1>
            <p className="crm-sub">The departments people are posted to, and who heads each one.</p>
          </div>
          <div className="dm-tools">
            <div className="crm-search dm-search">
              <IconSearch size={15} />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search departments…"
                aria-label="Search departments"
              />
            </div>
            <span className="crm-sub crm-nowrap">
              {total} department{total === 1 ? '' : 's'}
            </span>
            {isAdmin && (
              <button className="btn btn-primary" onClick={() => setEditing('new')}>
                <IconPlus size={15} /> Add Department
              </button>
            )}
          </div>
        </div>

        {(error || departments.error) && (
          <div className="dm-error"><ErrorNote>{error ?? departments.error}</ErrorNote></div>
        )}

        {departments.loading && !departments.data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState
            title={q ? 'No department matches that search' : 'No departments yet'}
            body={q ? 'Try a different name or code.' : 'Add the departments your people are posted to.'}
            action={
              isAdmin && !q ? (
                <button className="btn btn-primary" onClick={() => setEditing('new')}>
                  Add the first one
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Department</th>
                  <th>Code</th>
                  <th>Head</th>
                  <th className="crm-num">Employees</th>
                  <th>Status</th>
                  {isAdmin && <th style={{ textAlign: 'right' }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <span className="crm-strong">{d.name}</span>
                      {d.description && <div className="crm-sub">{d.description}</div>}
                    </td>
                    <td className="crm-muted">{d.code ?? '—'}</td>
                    <td>{d.head_name ?? <span className="crm-muted">—</span>}</td>
                    <td className="crm-num dm-count">{d.member_count}</td>
                    <td>
                      <span className={`crm-state ${d.is_active ? 'crm-state-good' : 'crm-state-idle'}`}>
                        {d.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    {isAdmin && (
                      <td>
                        <div className="crm-row-actions">
                          <button
                            className="crm-icon-btn"
                            onClick={() => setEditing(d)}
                            aria-label={`Edit ${d.name}`}
                            title="Edit"
                          >
                            <IconEdit size={16} />
                          </button>
                          <button
                            className="crm-icon-btn dm-delete"
                            onClick={() => remove(d)}
                            aria-label={`Delete ${d.name}`}
                            title="Delete"
                          >
                            <IconTrash size={16} />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && (
        <DepartmentDialog
          department={editing === 'new' ? null : editing}
          departments={departments.data ?? []}
          people={people.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            reloadAll()
          }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ dialog --- */

function DepartmentDialog({
  department,
  departments,
  people,
  onClose,
  onSaved,
}: {
  department: Department | null
  departments: Department[]
  people: User[]
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    name: department?.name ?? '',
    code: department?.code ?? '',
    description: department?.description ?? '',
    head_user_id: department?.head_user_id ?? '',
    parent_id: department?.parent_id ?? '',
    is_active: department?.is_active ?? true,
  })
  const current = useMemo(
    () => (department ? people.filter((p) => p.department_id === department.id).map((p) => p.id) : []),
    [department, people],
  )
  const [memberIds, setMemberIds] = useState<string[]>(current)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const members = people.filter((p) => memberIds.includes(p.id))
  const set = (key: keyof typeof form, value: string | boolean) => setForm((f) => ({ ...f, [key]: value }))

  async function save() {
    if (!form.name.trim()) {
      setError('Give it a name.')
      return
    }
    setBusy(true)
    setError(null)
    const body = {
      name: form.name.trim(),
      code: form.code.trim() || null,
      description: form.description.trim() || null,
      head_user_id: form.head_user_id || null,
      parent_id: form.parent_id || null,
      is_active: form.is_active,
    }
    let saved: Department
    try {
      saved = department
        ? await api.patch<Department>(`/org/departments/${department.id}`, body)
        : await api.post<Department>('/org/departments', body)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That department could not be saved')
      setBusy(false)
      return
    }

    const added = memberIds.filter((id) => !current.includes(id))
    const removed = current.filter((id) => !memberIds.includes(id))
    try {
      if (added.length) await api.post('/org/assign', { user_ids: added, department_id: saved.id })
      if (removed.length) await api.post('/org/assign', { user_ids: removed, clear_department: true })
      onSaved()
    } catch (err) {
      // The department itself is saved; say so, so a retry is an edit and not
      // a second department with the same name.
      setError(`Department saved, but the employees were not updated: ${
        err instanceof Error ? err.message : 'unknown error'
      }`)
      setBusy(false)
    }
  }

  // One dialog at a time: the picker replaces this one rather than stacking on
  // it, so Escape closes the picker and not both.
  if (picking) {
    return (
      <MemberPicker
        people={people}
        initial={memberIds}
        onClose={() => setPicking(false)}
        onDone={(ids) => {
          setMemberIds(ids)
          setPicking(false)
        }}
      />
    )
  }

  return (
    <Dialog
      title={department ? `Edit ${department.name}` : 'Add Department'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : department ? 'Save' : 'Create department'}
          </button>
        </>
      }
    >
      <div className="crm-form">
        {error && <div className="crm-form-wide"><ErrorNote>{error}</ErrorNote></div>}
        <Field label="Name">
          <input value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus />
        </Field>
        <Field label="Code">
          <input value={form.code} onChange={(e) => set('code', e.target.value.toUpperCase())} placeholder="ENG" />
        </Field>
        <Field label="Head of department" hint="Heads can see everyone in the department.">
          <select value={form.head_user_id} onChange={(e) => set('head_user_id', e.target.value)}>
            <option value="">Unassigned</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        </Field>
        <Field label="Parent department">
          <select value={form.parent_id} onChange={(e) => set('parent_id', e.target.value)}>
            <option value="">None — top level</option>
            {departments
              .filter((d) => d.id !== department?.id)
              .map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Description" wide>
          <input value={form.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        {/* A div, not Field: Field is a <label>, which would forward a click
            anywhere on the names to the button inside it. */}
        <div className="crm-field crm-form-wide">
          <span className="crm-field-label">Employees ({members.length})</span>
          <div className="dm-members">
            <span className="crm-sub">
              {members.length ? members.map((p) => p.full_name).join(', ') : 'Nobody yet.'}
            </span>
            <button type="button" className="btn btn-sm" onClick={() => setPicking(true)}>
              <IconPlus size={14} /> Add employees
            </button>
          </div>
        </div>
        <div className="crm-field crm-form-wide">
          <label className="crm-check">
            <input type="checkbox" checked={form.is_active} onChange={(e) => set('is_active', e.target.checked)} />
            Active
          </label>
        </div>
      </div>
    </Dialog>
  )
}

/* ------------------------------------------------------------ member picker --- */

/** Ticks the employees a department should hold. It only collects the
 *  selection — the caller assigns them once the department is saved. Anyone in
 *  another department is moved, and the row says where they are now. */
export function MemberPicker({
  people,
  initial,
  onClose,
  onDone,
}: {
  people: User[]
  initial: string[]
  onClose: () => void
  onDone: (ids: string[]) => void
}) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set(initial))

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase()
    return people.filter(
      (p) =>
        !q ||
        p.full_name.toLowerCase().includes(q) ||
        p.email.toLowerCase().includes(q) ||
        (p.employee_code ?? '').toLowerCase().includes(q),
    )
  }, [people, query])

  function toggle(id: string) {
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Dialog's styles are scoped under .crm, so the shell carries it here.
  return (
    <div className="crm">
      <Dialog
        title="Add employees"
        subtitle="They join this department when it is saved. Anyone already in another department is moved."
        onClose={onClose}
        footer={
          <>
            <Link to="/employees/new" className="btn btn-sm">New employee</Link>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={() => onDone([...picked])}>
              {picked.size ? `Select ${picked.size}` : 'Select none'}
            </button>
          </>
        }
      >
        <div className="org-pick">
          <input
            className="org-pick-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // The picker can render inside a form, where Enter would submit it.
            onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
            placeholder="Search by name, email or code"
            autoFocus
          />
          <div className="org-pick-list">
            {candidates.map((p) => (
              <label key={p.id} className="crm-check org-pick-row">
                <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
                <span>
                  <b>{p.full_name}</b>
                  <span className="muted-sm">
                    {' '}· {p.employee_code ?? p.email}
                    {p.department_name && ` · now in ${p.department_name}`}
                  </span>
                </span>
              </label>
            ))}
            {candidates.length === 0 && (
              <div className="muted-sm org-pick-empty">
                {query ? 'Nobody matches that search.' : 'No employees yet.'}
              </div>
            )}
          </div>
        </div>
      </Dialog>
    </div>
  )
}
