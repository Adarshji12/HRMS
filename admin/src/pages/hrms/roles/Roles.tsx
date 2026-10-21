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
import { ERP_PERMISSIONS, PERMISSIONS } from '../../../lib/employeeFields'
import { IconChevronDown, IconPlus, IconUsers } from '../../../components/Icons'
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

const LEVEL_LABEL: Record<string, string> = {
  owner: 'Owner', admin: 'Administrator', manager: 'Manager', employee: 'Standard',
}

export default function Roles() {
  const rolesQ = useQuery<OrgRole[]>('org-roles', () => api.get<OrgRole[]>('/roles'))
  /* Every role starts open. The page is opened to review what roles allow, and
     a list of closed headers makes that a click per role; collapsing is there
     for whoever wants to focus on one. */
  const [closed, setClosed] = useState<Set<string>>(() => new Set())
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const roles = rolesQ.data ?? []
  const total = PERMISSIONS.length + ERP_PERMISSIONS.length
  const toggle = (id: string) =>
    setClosed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const kpis = [
    { label: 'Roles', value: roles.length, hint: 'Built-in and custom', tone: 'brand' },
    { label: 'Built-in', value: roles.filter((r) => r.is_builtin).length, hint: 'Name and level fixed', tone: 'idle' },
    { label: 'Custom', value: roles.filter((r) => !r.is_builtin).length, hint: 'Made for this company', tone: 'good' },
    { label: 'People assigned', value: roles.reduce((n, r) => n + r.member_count, 0), hint: 'Across every role', tone: 'warn' },
  ]

  return (
    <div className="page rl-page">
      <header className="rl-hero">
        <div className="rl-hero-text">
          <span className="rl-eyebrow">Access control</span>
          <h1 className="rl-title">Roles &amp; permissions</h1>
          <p className="rl-sub">
            What a role can do, and how much of the company it can see. Editing one
            takes effect immediately for everybody holding it.
          </p>
        </div>
        <div className="rl-hero-actions">
          {roles.length > 0 && (
            <>
              <button className="btn" onClick={() => setClosed(new Set())}>Expand all</button>
              <button className="btn" onClick={() => setClosed(new Set(roles.map((r) => r.id)))}>Collapse all</button>
            </>
          )}
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <IconPlus size={15} /> New role
          </button>
        </div>
      </header>

      {roles.length > 0 && (
        <div className="rl-kpis" role="group" aria-label="Roles summary">
          {kpis.map((kpi) => (
            <div key={kpi.label} className={`rl-kpi tone-${kpi.tone}`}>
              <span className="rl-kpi-label"><span className="rl-kpi-dot" aria-hidden />{kpi.label}</span>
              <span className="rl-kpi-value">{kpi.value}</span>
              <span className="rl-kpi-hint">{kpi.hint}</span>
            </div>
          ))}
        </div>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}
      {rolesQ.error && <ErrorNote>{rolesQ.error}</ErrorNote>}

      {creating && (
        <section className="card rl-card rl-card-new">
          <div className="rl-head rl-head-static">
            <span className="rl-badge" aria-hidden><IconPlus size={18} /></span>
            <div className="rl-head-main">
              <div className="rl-name">New role</div>
              <div className="rl-desc">Name it, choose what it can see, then switch on what it can do.</div>
            </div>
          </div>
          <RoleEditor
            role={null}
            onClose={() => setCreating(false)}
            onSaved={() => { setCreating(false); rolesQ.reload() }}
            onError={setError}
          />
        </section>
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
          {roles.map((role) => {
            const open = !closed.has(role.id)
            const on = Object.values(role.permissions).filter(Boolean).length
            return (
              <section className={`card rl-card level-${role.base_role}`} key={role.id}>
                <button
                  className="rl-head"
                  onClick={() => toggle(role.id)}
                  aria-expanded={open}
                >
                  <span className="rl-badge" aria-hidden>{role.name.charAt(0).toUpperCase()}</span>
                  <div className="rl-head-main">
                    <div className="rl-name">
                      {role.name}
                      <span className="rl-level">{LEVEL_LABEL[role.base_role] ?? role.base_role}</span>
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
                      <span className="rl-fact-meter">
                        {on} / {total}
                        <span className="rl-mini-bar" aria-hidden><span style={{ width: `${(on / total) * 100}%` }} /></span>
                      </span>
                    </span>
                    <span className="rl-fact">
                      <span className="rl-fact-label">People</span>
                      {role.member_count}
                    </span>
                  </div>
                  <IconChevronDown size={16} className="rl-chevron" />
                </button>

                {open && (
                  <RoleEditor
                    role={role}
                    onClose={() => toggle(role.id)}
                    onSaved={() => rolesQ.reload()}
                    onError={setError}
                  />
                )}
              </section>
            )
          })}
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

  const allOn = ALL_KEYS.every((k) => perms[k])
  const setMany = (keys: readonly string[], on: boolean) => {
    const next = { ...perms }
    for (const k of keys) next[k] = on
    setPerms(next)
  }

  return (
    <div className={role ? 'rl-editor' : 'card rl-editor rl-editor-new'}>
      <div className="rl-layout">
        <div className="rl-matrix-wrap">
          <div className="rl-matrix-head">
            <div>
              <h3 className="rl-set-head">Can do</h3>
              <p className="rl-set-hint">
                Everything not switched on is off. A permission added to the product later
                stays off for every role until somebody turns it on here.
              </p>
            </div>
            <span className="rl-count">
              {ALL_KEYS.filter((k) => perms[k]).length} / {ALL_KEYS.length} on
            </span>
          </div>

          <div className="rl-matrix">
            {MODULES.map((m) => (
              <ModuleRow key={m.key} module={m} perms={perms} busy={busy}
                         setOne={(k, on) => setPerms({ ...perms, [k]: on })} setMany={setMany} />
            ))}
          </div>
        </div>

        <aside className="rl-side">
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

          <label className="rl-field">
            <span className="rl-field-label">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={busy}
              maxLength={300}
              rows={3}
              placeholder="Approves and pays expense claims company-wide. Manages nobody."
            />
          </label>

          <div className="rl-panel">
            <span className="rl-field-label">Access</span>
            <label className={`rl-radio${allOn ? ' is-on' : ''}`}>
              <input type="radio" name={`access-${role?.id ?? 'new'}`} checked={allOn} disabled={busy}
                     onChange={() => setMany(ALL_KEYS, true)} />
              <span>All access<small>Every permission below, switched on.</small></span>
            </label>
            <label className={`rl-radio${!allOn ? ' is-on' : ''}`}>
              <input type="radio" name={`access-${role?.id ?? 'new'}`} checked={!allOn} disabled={busy}
                     onChange={() => setMany(ALL_KEYS, false)} />
              <span>Limit access<small>Only what is switched on, module by module.</small></span>
            </label>
          </div>

          {/* Level and scope together, because the interesting roles are the ones
              where they disagree — Standard level with company scope is a
              reviewer who administers nothing. */}
          <fieldset className="rl-panel">
            <legend className="rl-field-label">Level</legend>
            {BASE_ROLES.map((option) => (
              <label className={`rl-radio${baseRole === option.value ? ' is-on' : ''}`} key={option.value}>
                <input
                  type="radio"
                  name={`base-${role?.id ?? 'new'}`}
                  checked={baseRole === option.value}
                  disabled={locked || busy}
                  onChange={() => setBaseRole(option.value)}
                />
                <span>{option.label}<small>{option.hint}</small></span>
              </label>
            ))}
          </fieldset>

          <fieldset className="rl-panel">
            <legend className="rl-field-label">Can see</legend>
            {SCOPES.map((option) => (
              <label className={`rl-radio${scope === option.value ? ' is-on' : ''}`} key={option.value}>
                <input
                  type="radio"
                  name={`scope-${role?.id ?? 'new'}`}
                  checked={scope === option.value}
                  disabled={busy}
                  onChange={() => setScope(option.value)}
                />
                <span>{option.label}<small>{option.hint}</small></span>
              </label>
            ))}
          </fieldset>
        </aside>
      </div>

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

/* ------------------------------------------------------- module matrix --- */

type Column = 'manage' | 'approve' | 'financial' | 'sensitive'

const COLUMNS: Array<{ key: Column; label: string }> = [
  { key: 'manage', label: 'Manage' },
  { key: 'approve', label: 'Approve' },
  { key: 'financial', label: 'Financial' },
  { key: 'sensitive', label: 'Sensitive' },
]

interface ModuleDef {
  key: string
  label: string
  perms: Array<{ key: string; col: Column }>
}

/* Every permission sits in exactly one module and one column. The column is
   the kind of power it grants, so a row of switches answers the four questions
   somebody asks about a role in a module: may they operate it, sign things
   off, move money, see the sensitive part. */
const MODULES: ModuleDef[] = [
  { key: 'people', label: 'People & HR', perms: [
    { key: 'can_manage_people', col: 'manage' },
    { key: 'can_manage_onboarding', col: 'manage' },
    { key: 'can_issue_letters', col: 'approve' },
  ] },
  { key: 'attendance', label: 'Attendance & Leave', perms: [
    { key: 'can_approve_leave', col: 'approve' },
    { key: 'can_approve_regularization', col: 'approve' },
    { key: 'can_punch_anywhere', col: 'sensitive' },
  ] },
  { key: 'payroll', label: 'Payroll & Expenses', perms: [
    { key: 'can_approve_expenses', col: 'approve' },
    { key: 'can_approve_loans', col: 'approve' },
    { key: 'can_manage_payroll', col: 'financial' },
    { key: 'can_reimburse_expenses', col: 'financial' },
    { key: 'can_disburse_loans', col: 'financial' },
  ] },
  { key: 'time', label: 'Time & Projects', perms: [
    { key: 'can_manage_projects', col: 'manage' },
    { key: 'can_approve_timesheets', col: 'approve' },
    { key: 'can_view_screenshots', col: 'sensitive' },
    { key: 'can_export_data', col: 'sensitive' },
  ] },
  { key: 'workplace', label: 'Workplace', perms: [
    { key: 'can_manage_assets', col: 'manage' },
    { key: 'can_manage_helpdesk', col: 'manage' },
    { key: 'can_manage_performance', col: 'manage' },
    { key: 'can_manage_engagement', col: 'manage' },
  ] },
  { key: 'erp-masters', label: 'ERP · Masters & Vendors', perms: [
    { key: 'can_manage_erp_masters', col: 'manage' },
    { key: 'can_verify_vendors', col: 'approve' },
  ] },
  { key: 'erp-procurement', label: 'ERP · Procurement', perms: [
    { key: 'can_manage_procurement', col: 'manage' },
    { key: 'can_approve_purchases', col: 'approve' },
  ] },
  { key: 'erp-inventory', label: 'ERP · Inventory', perms: [
    { key: 'can_manage_inventory', col: 'manage' },
    { key: 'can_approve_stock', col: 'approve' },
  ] },
  { key: 'erp-sales', label: 'ERP · Sales', perms: [
    { key: 'can_manage_sales_orders', col: 'manage' },
    { key: 'can_approve_sales_orders', col: 'approve' },
  ] },
  { key: 'erp-billing', label: 'ERP · Billing', perms: [
    { key: 'can_manage_billing', col: 'financial' },
    { key: 'can_approve_billing', col: 'approve' },
  ] },
]

const PERM_INFO: Record<string, { label: string; description: string }> = Object.fromEntries(
  [...PERMISSIONS, ...ERP_PERMISSIONS].map((p) => [
    p.key, { label: p.label.replace(/^ERP · /, ''), description: p.description },
  ]),
)

/* A permission no module claims still gets a row, so one added to the lists
   later is never silently missing from this screen. */
const CLAIMED = new Set(MODULES.flatMap((m) => m.perms.map((p) => p.key)))
const UNCLAIMED = Object.keys(PERM_INFO).filter((k) => !CLAIMED.has(k))
if (UNCLAIMED.length) {
  MODULES.push({ key: 'other', label: 'Other', perms: UNCLAIMED.map((key) => ({ key, col: 'manage' as Column })) })
}
const ALL_KEYS = MODULES.flatMap((m) => m.perms.map((p) => p.key))

type Fill = 'all' | 'some' | 'none'
function fill(keys: string[], perms: Record<string, boolean>): Fill {
  const n = keys.filter((k) => perms[k]).length
  return n === 0 ? 'none' : n === keys.length ? 'all' : 'some'
}

function ModuleRow({
  module: m, perms, busy, setOne, setMany,
}: {
  module: ModuleDef
  perms: Record<string, boolean>
  busy: boolean
  setOne: (key: string, on: boolean) => void
  setMany: (keys: readonly string[], on: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const keys = m.perms.map((p) => p.key)
  const state = fill(keys, perms)
  const n = m.perms.length

  return (
    <div className={`rl-mod${open ? ' is-open' : ''}`}>
      <div className="rl-mod-head">
        <input
          type="checkbox"
          className="rl-mod-check"
          checked={state === 'all'}
          ref={(el) => { if (el) el.indeterminate = state === 'some' }}
          disabled={busy}
          onChange={() => setMany(keys, state !== 'all')}
          aria-label={`Every permission in ${m.label}`}
        />
        <div className="rl-mod-title">
          <span className="rl-mod-name">{m.label}</span>
          <button type="button" className="rl-mod-more" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide' : 'Show'} {n} permission{n === 1 ? '' : 's'}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>
        {COLUMNS.map((c) => {
          const colKeys = m.perms.filter((p) => p.col === c.key).map((p) => p.key)
          const s = fill(colKeys, perms)
          return (
            <div className="rl-col" key={c.key}>
              <span className="rl-col-label">{c.label}</span>
              {colKeys.length ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={s === 'all' ? 'true' : s === 'some' ? 'mixed' : 'false'}
                  aria-label={`${m.label}: ${c.label}`}
                  className={`rl-switch is-${s}`}
                  disabled={busy}
                  onClick={() => setMany(colKeys, s !== 'all')}
                  title={s === 'some' ? 'Partly on' : undefined}
                >
                  <span className="rl-switch-knob" />
                </button>
              ) : (
                <span className="rl-switch-na" title="Nothing of this kind in this module">—</span>
              )}
            </div>
          )
        })}
      </div>

      {open && (
        <div className="rl-mod-body">
          {m.perms.map((p) => {
            const info = PERM_INFO[p.key]
            return (
              <div className="rl-mod-row" key={p.key}>
                <div className="rl-mod-perm">
                  <span className="rl-perm-label">{info?.label ?? p.key}</span>
                  {info && <span className="rl-perm-desc">{info.description}</span>}
                </div>
                {COLUMNS.map((c) => (
                  <div className={`rl-cell${c.key === p.col ? ' is-live' : ''}`} key={c.key}>
                    {c.key === p.col && (
                      <input
                        type="checkbox"
                        checked={Boolean(perms[p.key])}
                        disabled={busy}
                        onChange={(e) => setOne(p.key, e.target.checked)}
                        aria-label={info?.label ?? p.key}
                      />
                    )}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
