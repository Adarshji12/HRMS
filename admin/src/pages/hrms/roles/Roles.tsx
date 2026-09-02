/* Named roles: what a person can do, and how much of the company they see.
 *
 * Two ideas kept apart on the screen because they are kept apart in the data,
 * and because conflating them is the mistake this page exists to prevent.
 *
 * **Can do** is a permission set. **Can see** is a data scope. Before roles
 * existed, scope was inferred from the role level, so somebody who had to
 * review the whole company's expenses but managed nobody could only be given it
 * by making them an administrator — handing over payroll and settings to solve
 * a reporting problem. The two columns here are the fix.
 *
 * Editing a role takes effect immediately for everybody holding it. That is the
 * point of roles, and it is why the member count sits beside the save button
 * rather than in a tooltip: unticking "approve leave" on a role held by
 * fourteen people is a decision about fourteen people.
 */

import { useEffect, useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { ErrorNote, Loading, EmptyState } from '../../../components/ui'
import { PERMISSIONS } from '../../../lib/employeeFields'
import { IconUsers } from '../../../components/Icons'
import '../../../styles/roles.css'

export interface OrgRole {
  id: string
  name: string
  description: string | null
  base_role: string
  data_scope: string
  permissions: Record<string, boolean>
  is_builtin: boolean
  member_count: number
}

/* The four levels a role can stand in for. Named for what they mean rather than
   for the enum value, because "employee" as a *level* is the thing that confuses
   people — a Finance Officer sits at employee level and still sees everything,
   which is exactly the combination the old model could not express. */
const BASE_ROLES: Array<{ value: string; label: string; hint: string }> = [
  { value: 'employee', label: 'Standard', hint: 'No administration. Pair with a wider scope for reviewer roles.' },
  { value: 'manager', label: 'Manager', hint: 'Line management. Approvals and their own reporting line.' },
  { value: 'admin', label: 'Administrator', hint: 'Runs the workspace — settings, employees, company data.' },
]

const SCOPES: Array<{ value: string; label: string; hint: string }> = [
  { value: 'self', label: 'Only themselves', hint: 'Their own record and their own requests.' },
  { value: 'team', label: 'Their team', hint: 'Their reporting line, plus any team or department they head.' },
  { value: 'department', label: 'Their department', hint: 'Everyone in the same department, whether or not they report to them.' },
  { value: 'company', label: 'The whole company', hint: 'Everybody. Grant deliberately — it is not tied to being an administrator.' },
]

export default function Roles() {
  const rolesQ = useQuery<OrgRole[]>('org-roles', () => api.get<OrgRole[]>('/roles'))
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const roles = rolesQ.data ?? []

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Roles</h1>
          <p>
            What a role can do, and how much of the company it can see. Editing one
            takes effect immediately for everybody holding it.
          </p>
        </div>
        <div className="head-actions">
          <button className="btn btn-primary" onClick={() => { setCreating(true); setOpenId(null) }}>
            New role
          </button>
        </div>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}
      {rolesQ.error && <ErrorNote>{rolesQ.error}</ErrorNote>}

      {creating && (
        <RoleEditor
          role={null}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); rolesQ.reload() }}
          onError={setError}
        />
      )}

      {rolesQ.loading ? (
        <Loading />
      ) : roles.length === 0 ? (
        <EmptyState
          icon={<IconUsers size={22} />}
          title="No roles yet"
          body="The four built-in roles appear the first time this page loads. If none are here, the workspace could not be read."
        />
      ) : (
        <div className="rl-list">
          {roles.map((role) => (
            <section className="card rl-card" key={role.id}>
              <button
                className="rl-head"
                onClick={() => { setOpenId(openId === role.id ? null : role.id); setCreating(false) }}
                aria-expanded={openId === role.id}
              >
                <div className="rl-head-main">
                  <div className="rl-name">
                    {role.name}
                    {role.is_builtin && <span className="rl-tag">Built-in</span>}
                  </div>
                  {role.description && <div className="rl-desc">{role.description}</div>}
                </div>
                <div className="rl-facts">
                  <span className="rl-fact">
                    <span className="rl-fact-label">Can see</span>
                    {SCOPES.find((s) => s.value === role.data_scope)?.label ?? role.data_scope}
                  </span>
                  <span className="rl-fact">
                    <span className="rl-fact-label">Permissions</span>
                    {Object.values(role.permissions).filter(Boolean).length} of {PERMISSIONS.length}
                  </span>
                  <span className="rl-fact">
                    <span className="rl-fact-label">People</span>
                    {role.member_count}
                  </span>
                </div>
              </button>

              {openId === role.id && (
                <RoleEditor
                  role={role}
                  onClose={() => setOpenId(null)}
                  onSaved={() => { setOpenId(null); rolesQ.reload() }}
                  onError={setError}
                />
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function RoleEditor({
  role,
  onClose,
  onSaved,
  onError,
}: {
  role: OrgRole | null
  onClose: () => void
  onSaved: () => void
  onError: (m: string | null) => void
}) {
  const [name, setName] = useState(role?.name ?? '')
  const [description, setDescription] = useState(role?.description ?? '')
  const [baseRole, setBaseRole] = useState(role?.base_role ?? 'employee')
  const [scope, setScope] = useState(role?.data_scope ?? 'self')
  const [perms, setPerms] = useState<Record<string, boolean>>(role?.permissions ?? {})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setName(role?.name ?? '')
    setDescription(role?.description ?? '')
    setBaseRole(role?.base_role ?? 'employee')
    setScope(role?.data_scope ?? 'self')
    setPerms(role?.permissions ?? {})
  }, [role])

  /* A built-in's name and level are fixed. Its permissions and scope are not:
     companies genuinely want a Manager who cannot see screenshots. None of them
     want a Manager whose level is quietly Administrator — the coarse checks read
     that, and it would hand out settings from a screen about approving leave. */
  const locked = Boolean(role?.is_builtin)

  async function save() {
    onError(null)
    setBusy(true)
    try {
      const body = {
        name, description,
        base_role: baseRole,
        data_scope: scope,
        permissions: perms,
      }
      if (role) await api.patch(`/roles/${role.id}`, body)
      else await api.post('/roles', body)
      onSaved()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save the role.')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!role) return
    onError(null)
    setBusy(true)
    try {
      await api.del(`/roles/${role.id}`)
      onSaved()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not delete the role.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={role ? 'rl-editor' : 'card rl-editor rl-editor-new'}>
      <div className="rl-grid">
        <label className="rl-field">
          <span className="rl-field-label">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={locked || busy}
            maxLength={80}
            placeholder="Finance Officer"
          />
          {locked && <span className="rl-field-hint">Built-in roles cannot be renamed.</span>}
        </label>

        <label className="rl-field rl-field-wide">
          <span className="rl-field-label">Description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy}
            maxLength={300}
            placeholder="Approves and pays expense claims company-wide. Manages nobody."
          />
          <span className="rl-field-hint">
            Shown when assigning somebody. “Finance Officer” alone does not say whether
            they can see salaries.
          </span>
        </label>
      </div>

      <div className="rl-two">
        {/* Level and scope, side by side, because the interesting roles are the
            ones where they disagree — Standard level with company scope is a
            reviewer who administers nothing. */}
        <fieldset className="rl-set">
          <legend className="rl-set-head">Level</legend>
          <p className="rl-set-hint">Which built-in level this role behaves as.</p>
          {BASE_ROLES.map((option) => (
            <label className={`rl-opt${baseRole === option.value ? ' rl-opt-on' : ''}`} key={option.value}>
              <input
                type="radio"
                name={`base-${role?.id ?? 'new'}`}
                checked={baseRole === option.value}
                disabled={locked || busy}
                onChange={() => setBaseRole(option.value)}
              />
              <span className="rl-opt-label">{option.label}</span>
              <span className="rl-opt-hint">{option.hint}</span>
            </label>
          ))}
        </fieldset>

        <fieldset className="rl-set">
          <legend className="rl-set-head">Can see</legend>
          <p className="rl-set-hint">How much of the company. Separate from what they can do.</p>
          {SCOPES.map((option) => (
            <label className={`rl-opt${scope === option.value ? ' rl-opt-on' : ''}`} key={option.value}>
              <input
                type="radio"
                name={`scope-${role?.id ?? 'new'}`}
                checked={scope === option.value}
                disabled={busy}
                onChange={() => setScope(option.value)}
              />
              <span className="rl-opt-label">{option.label}</span>
              <span className="rl-opt-hint">{option.hint}</span>
            </label>
          ))}
        </fieldset>
      </div>

      <fieldset className="rl-set rl-perms">
        <legend className="rl-set-head">Can do</legend>
        <p className="rl-set-hint">
          Everything not ticked is off. A permission added to the product later stays
          off for every role until somebody turns it on here.
        </p>
        <div className="rl-perm-grid">
          {PERMISSIONS.map((p) => (
            <label className="rl-perm" key={p.key}>
              <input
                type="checkbox"
                checked={Boolean(perms[p.key])}
                disabled={busy}
                onChange={(e) => setPerms({ ...perms, [p.key]: e.target.checked })}
              />
              <span className="rl-perm-body">
                <span className="rl-perm-label">{p.label}</span>
                <span className="rl-perm-desc">{p.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="rl-actions">
        <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void save()}>
          {busy ? 'Saving…' : role ? 'Save role' : 'Create role'}
        </button>
        <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
        {role && !role.is_builtin && (
          <button className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
            Delete role
          </button>
        )}
        {role && role.member_count > 0 && (
          /* Beside the save button on purpose. Saving is not a draft — it
             changes what these people can do the moment it lands. */
          <span className="rl-warn">
            {role.member_count} {role.member_count === 1 ? 'person holds' : 'people hold'} this
            role. Saving changes what they can do immediately.
          </span>
        )}
      </div>
    </div>
  )
}
