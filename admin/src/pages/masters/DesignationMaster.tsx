/* Designation Master — the Organisation Master's job titles, on the same card
 * layout as Department Master.
 *
 * Seniority is a ladder: level 1 is the most senior, and the list is read top
 * down in that order. A title can be tied to one department or left open to
 * any of them.
 */

import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import '../../styles/crm.css'
import '../../styles/org.css'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { canAdminister, useAuth } from '../../lib/auth'
import type { Department, Designation } from '../../lib/types'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconBriefcase, IconEdit, IconPlus, IconSearch, IconTrash } from '../../components/Icons'
import { Dialog, Field } from '../crm/parts'
import { MasterTrail } from './MasterBack'
import {
  ColumnSettings, FieldSettings, useColumns, useFieldModes,
  type ColumnDef, type FieldDef, type FieldSection,
} from '../../components/ViewSettings'

/** What the designation list can show; the first five are the default. */
type DesignationColumn = ColumnDef & {
  td: (row: Designation) => ReactNode
  className?: string
  thClass?: string
  thStyle?: CSSProperties
}
const DESIGNATION_COLUMNS: DesignationColumn[] = [
  { key: 'level', label: 'Level', thStyle: { width: 60 }, td: (d) => <span className="dm-level">{d.level}</span> },
  { key: 'designation', label: 'Designation', locked: true, td: (d) => <span className="crm-strong">{d.name}</span> },
  { key: 'department', label: 'Department', className: 'crm-muted', td: (d) => d.department_name ?? 'Any' },
  { key: 'employees', label: 'Employees', className: 'crm-num dm-count', thClass: 'crm-num', td: (d) => d.member_count },
  { key: 'code', label: 'Short code', initial: false, td: (d) => d.code ?? <span className="crm-muted">—</span> },
  { key: 'status', label: 'Status', td: (d) => (
    <span className={`crm-state ${d.is_active ? 'crm-state-good' : 'crm-state-idle'}`}>
      {d.is_active ? 'Active' : 'Inactive'}
    </span>
  ) },
]

/** What the designation form can show, make mandatory or hide. The name is what
 *  the server needs; the level starts mandatory because the form insists on it,
 *  and keeps its default value when hidden. */
const DESIGNATION_SECTIONS: FieldSection[] = [{ id: 'designation', label: 'Designation' }]
const DESIGNATION_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Name', section: 'designation', fixed: true },
  { key: 'level', label: 'Seniority level', section: 'designation', initial: 'mandatory' },
  { key: 'code', label: 'Short code', section: 'designation' },
  { key: 'department', label: 'Only in department', section: 'designation' },
  { key: 'active', label: 'Offered when adding an employee', section: 'designation', optionalOnly: true },
]

const ORG_TRAIL_DESIGNATION = [
  { label: 'Master', to: '/masters' },
  { label: 'Organisation Master', to: '/masters' },
  { label: 'Designation' },
]

/** `readOnly` lists without add, edit or delete — as on HR Settings, where the masters
 *  are only listed; the Master menu is where they are kept. */
export default function DesignationMaster({ readOnly = false }: { readOnly?: boolean }) {
  const columns = useColumns('designations', DESIGNATION_COLUMNS)
  const { user } = useAuth()
  const isAdmin = canAdminister(user) && !readOnly
  const designations = useQuery<Designation[]>('designations', () =>
    api.get<Designation[]>('/org/designations'),
  )
  const departments = useQuery<Department[]>('departments', () =>
    api.get<Department[]>('/org/departments'),
  )
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Designation | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (designations.data ?? []).filter(
      (d) =>
        !needle ||
        d.name.toLowerCase().includes(needle) ||
        (d.department_name ?? '').toLowerCase().includes(needle),
    )
  }, [designations.data, q])

  async function remove(designation: Designation) {
    if (!window.confirm(`Delete “${designation.name}”?\n\nEmployees with this title keep their record — the title is simply cleared.`)) return
    setError(null)
    try {
      await api.del(`/org/designations/${designation.id}`)
      designations.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That designation could not be deleted')
    }
  }

  const total = designations.data?.length ?? 0
  // A new title goes to the bottom of the ladder unless told otherwise.
  const nextLevel = Math.max(0, ...(designations.data ?? []).map((d) => d.level)) + 1

  return (
    <div className="crm">
      <MasterTrail crumbs={ORG_TRAIL_DESIGNATION} />
      <section className="card dm-card">
        <div className="dm-head">
          <span className="dm-tile dm-tile-violet"><IconBriefcase size={18} /></span>
          <div className="dm-heading">
            <h1 className="dm-title">Designation Master</h1>
            <p className="crm-sub">Job titles and their seniority. Level 1 is the most senior.</p>
          </div>
          <div className="dm-tools">
            <div className="crm-search dm-search">
              <IconSearch size={15} />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search designations…"
                aria-label="Search designations"
              />
            </div>
            <span className="crm-sub crm-nowrap">
              {total} designation{total === 1 ? '' : 's'}
            </span>
            <ColumnSettings defs={DESIGNATION_COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden}
                            onSave={columns.save} onReset={columns.reset} />
            {isAdmin && (
              <button className="btn btn-primary" onClick={() => setEditing('new')}>
                <IconPlus size={15} /> Add Designation
              </button>
            )}
          </div>
        </div>

        {(error || designations.error) && (
          <div className="dm-error"><ErrorNote>{error ?? designations.error}</ErrorNote></div>
        )}

        {designations.loading && !designations.data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState
            title={q ? 'No designation matches that search' : 'No designations yet'}
            body={q ? 'Try a different title or department.' : 'Add the job titles your people hold, most senior first.'}
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
                  {(columns.visible as DesignationColumn[]).map((col) => (
                    <th key={col.key} className={col.thClass} style={col.thStyle}>{col.label}</th>
                  ))}
                  {isAdmin && <th style={{ textAlign: 'right' }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    {(columns.visible as DesignationColumn[]).map((col) => (
                      <td key={col.key} className={col.className}>{col.td(d)}</td>
                    ))}
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
        <DesignationDialog
          designation={editing === 'new' ? null : editing}
          departments={departments.data ?? []}
          defaultLevel={nextLevel}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            designations.reload()
          }}
        />
      )}
    </div>
  )
}

function DesignationDialog({
  designation,
  departments,
  defaultLevel,
  onClose,
  onSaved,
}: {
  designation: Designation | null
  departments: Department[]
  defaultLevel: number
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    name: designation?.name ?? '',
    code: designation?.code ?? '',
    level: String(designation?.level ?? defaultLevel),
    department_id: designation?.department_id ?? '',
    is_active: designation?.is_active ?? true,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (key: keyof typeof form, value: string | boolean) => setForm((f) => ({ ...f, [key]: value }))
  /* What this person has chosen to show, require or hide on the form. */
  const fields = useFieldModes('designation-form', DESIGNATION_FIELDS)
  const fm = fields.mode
  const rq = (key: string) => fm(key) === 'mandatory'
  const emptyField: Record<string, boolean> = { level: form.level.trim() === '', code: form.code.trim() === '', department: !form.department_id }
  const missing = Object.keys(emptyField).some((k) => fm(k) === 'mandatory' && emptyField[k])

  const fieldNodes: Record<string, ReactNode> = {
    name: (
      <Field label="Name" wide required>
        <input
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="Senior Executive"
          autoFocus
        />
      </Field>
    ),
    level: fm('level') !== 'hide' && (
      <Field label="Seniority level" required={rq('level')} hint="1 = most senior">
        <input placeholder="e.g. 3"
          type="number"
          min={1}
          max={100}
          value={form.level}
          onChange={(e) => set('level', e.target.value)}
        />
      </Field>
    ),
    code: fm('code') !== 'hide' && (
      <Field label="Short code" required={rq('code')}>
        <input value={form.code} maxLength={12} placeholder="SE"
               onChange={(e) => set('code', e.target.value.toUpperCase())} />
      </Field>
    ),
    department: fm('department') !== 'hide' && (
      <Field label="Only in department" wide required={rq('department')} hint="Leave blank when the title exists across the company">
        <select value={form.department_id} onChange={(e) => set('department_id', e.target.value)}>
          <option value=""></option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </Field>
    ),
    active: fm('active') !== 'hide' && (
      <div className="crm-field crm-form-wide">
        <label className="crm-check">
          <input type="checkbox" checked={form.is_active} onChange={(e) => set('is_active', e.target.checked)} />
          Offered when adding an employee
        </label>
      </div>
    ),
  }

  async function save() {
    const level = Number(form.level)
    if (!form.name.trim()) {
      setError('Give it a name.')
      return
    }
    if (missing) {
      setError('Fill in the fields marked *.')
      return
    }
    if (fm('level') !== 'hide' && (!Number.isInteger(level) || level < 1 || level > 100)) {
      setError('Level is a whole number from 1 (most senior) to 100.')
      return
    }
    setBusy(true)
    setError(null)
    const body = {
      name: form.name.trim(),
      code: form.code.trim() || null,
      level,
      department_id: form.department_id || null,
      is_active: form.is_active,
    }
    try {
      if (designation) await api.patch(`/org/designations/${designation.id}`, body)
      else await api.post('/org/designations', body)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That designation could not be saved')
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={designation ? `Edit ${designation.name}` : 'Add Designation'}
      narrow
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : designation ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      <div className="crm-form">
        {error && <div className="crm-form-wide"><ErrorNote>{error}</ErrorNote></div>}
        <div className="crm-form-wide lf-settings">
          <FieldSettings defs={DESIGNATION_FIELDS} sections={DESIGNATION_SECTIONS} modes={fields.modes} order={fields.order}
                         onSave={fields.save} onReset={fields.reset} />
        </div>
        {fields.orderOf('designation').map((key) => <Fragment key={key}>{fieldNodes[key]}</Fragment>)}
      </div>
    </Dialog>
  )
}
