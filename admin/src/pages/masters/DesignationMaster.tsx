/* Designation Master — the Organisation Master's job titles, on the same card
 * layout as Department Master.
 *
 * Seniority is a ladder: level 1 is the most senior, and the list is read top
 * down in that order. A title can be tied to one department or left open to
 * any of them.
 */

import { useMemo, useState } from 'react'
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

const ORG_TRAIL_DESIGNATION = [
  { label: 'Master', to: '/masters' },
  { label: 'Organisation Master', to: '/masters' },
  { label: 'Designation' },
]

export default function DesignationMaster() {
  const { user } = useAuth()
  const isAdmin = canAdminister(user)
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
                  <th style={{ width: 60 }}>Level</th>
                  <th>Designation</th>
                  <th>Department</th>
                  <th className="crm-num">Employees</th>
                  <th>Status</th>
                  {isAdmin && <th style={{ textAlign: 'right' }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td><span className="dm-level">{d.level}</span></td>
                    <td><span className="crm-strong">{d.name}</span></td>
                    <td className="crm-muted">{d.department_name ?? 'Any'}</td>
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
    level: String(designation?.level ?? defaultLevel),
    department_id: designation?.department_id ?? '',
    is_active: designation?.is_active ?? true,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (key: keyof typeof form, value: string | boolean) => setForm((f) => ({ ...f, [key]: value }))

  async function save() {
    const level = Number(form.level)
    if (!form.name.trim()) {
      setError('Give it a name.')
      return
    }
    if (!Number.isInteger(level) || level < 1 || level > 100) {
      setError('Level is a whole number from 1 (most senior) to 100.')
      return
    }
    setBusy(true)
    setError(null)
    const body = {
      name: form.name.trim(),
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
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : designation ? 'Save' : 'Create designation'}
          </button>
        </>
      }
    >
      <div className="crm-form">
        {error && <div className="crm-form-wide"><ErrorNote>{error}</ErrorNote></div>}
        <Field label="Designation" wide>
          <input
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Senior Executive"
            autoFocus
          />
        </Field>
        <Field label="Level" hint="1 is the most senior. Titles can share a level.">
          <input
            type="number"
            min={1}
            max={100}
            value={form.level}
            onChange={(e) => set('level', e.target.value)}
          />
        </Field>
        <Field label="Department" hint="Leave on Any for a title used across departments.">
          <select value={form.department_id} onChange={(e) => set('department_id', e.target.value)}>
            <option value="">Any</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
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
