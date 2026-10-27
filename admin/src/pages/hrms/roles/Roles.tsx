/* Roles & permissions — one role at a time, menu by menu.
 *
 * The roles sit in a row of tabs; the chosen one is edited below in two parts:
 *
 * **Details** — name, description, level and data scope. Level feeds the
 * coarse administrator / team checks; scope is how much of the company the role
 * sees. Kept apart from what it can do, because they are kept apart in the data
 * (a Finance Officer can see everybody and administer nothing).
 *
 * **Menus & permissions** — every menu in the app, grouped as the sidebar
 * groups it. Access shows the menu and opens its pages; Add / Edit / Delete are
 * enforced by the API on every write (core/menus.py); the chips under "Other
 * rights" are the older per-role switches — approving leave, seeing salaries —
 * placed on the menu they belong to and still enforced where they always were.
 *
 * A role nobody has limited by menu yet has `menu_rights: null` and reaches
 * every menu, so the screen shows it fully on and says so. The owner is never
 * limited. Saving changes what everybody holding the role can do immediately,
 * which is why the save bar names how many people that is.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { ErrorNote, Loading } from '../../../components/ui'
import { ERP_PERMISSIONS, PERMISSIONS } from '../../../lib/employeeFields'
import type { MenuRight, MenuRights } from '../../../lib/types'
import {
  IconBuilding, IconCard, IconClock, IconDashboard, IconGear, IconGrid, IconLifebuoy,
  IconPlus, IconSearch, IconShield, IconStar, IconUsers,
} from '../../../components/Icons'
import '../../../styles/roles.css'

export interface OrgRole {
  id: string
  name: string
  description: string | null
  base_role: string
  data_scope: string
  permissions: Record<string, boolean>
  menu_rights: MenuRights | null
  is_builtin: boolean
  member_count: number
}

interface MenuDef {
  key: string
  label: string
  parent: string | null
  note: string | null
  actions: Action[]
  rights: string[]
}

interface MenuGroup {
  key: string
  label: string
  description: string
  menus: MenuDef[]
}

type Action = 'add' | 'edit' | 'delete'
const ACTIONS: Action[] = ['add', 'edit', 'delete']

const BASE_ROLES = [
  { value: 'employee', label: 'Standard' },
  { value: 'manager', label: 'Manager' },
  { value: 'admin', label: 'Administrator' },
]

const SCOPES = [
  { value: 'self', label: 'Only themselves' },
  { value: 'team', label: 'Their team' },
  { value: 'department', label: 'Their department' },
  { value: 'company', label: 'The whole company' },
]

const LEVEL_LABEL: Record<string, string> = {
  owner: 'Owner', admin: 'Administrator', manager: 'Manager', employee: 'Standard',
}

const GROUP_ICON: Record<string, (p: { size?: number }) => JSX.Element> = {
  overview: IconDashboard, people: IconUsers, masters: IconGrid, hrms: IconUsers,
  time: IconClock, assets: IconBuilding, helpdesk: IconLifebuoy, crm: IconStar,
  erp: IconCard, settings: IconGear,
}

/* Chip labels: the permission's own label is a sentence, too long for a chip.
   The full description stays in the chip's tooltip. */
const SHORT: Record<string, string> = {
  can_view_screenshots: 'View screenshots',
  can_approve_timesheets: 'Approve timesheets',
  can_export_data: 'Export data',
  can_manage_projects: 'Manage projects',
  can_approve_leave: 'Approve leave',
  can_approve_regularization: 'Approve regularisation',
  can_punch_anywhere: 'Punch from anywhere',
  can_manage_assets: 'Manage assets',
  can_manage_onboarding: 'Manage onboarding',
  can_manage_helpdesk: 'Manage helpdesk',
  can_manage_people: 'Manage people',
  can_issue_letters: 'Issue letters',
  can_approve_expenses: 'Approve expenses',
  can_reimburse_expenses: 'Reimburse',
  can_approve_loans: 'Approve loans',
  can_disburse_loans: 'Disburse loans',
  can_manage_payroll: 'Run payroll',
  can_manage_performance: 'Manage reviews',
  can_manage_engagement: 'Post announcements',
  can_manage_erp_masters: 'Maintain masters',
  can_verify_vendors: 'Verify vendors',
  can_manage_procurement: 'Run procurement',
  can_approve_purchases: 'Approve purchases',
  can_manage_inventory: 'Move stock',
  can_approve_stock: 'Approve stock',
  can_manage_sales_orders: 'Raise orders',
  can_approve_sales_orders: 'Approve orders',
  can_manage_billing: 'Bill',
  can_approve_billing: 'Approve billing',
}

const DESCRIPTION: Record<string, string> = Object.fromEntries(
  [...PERMISSIONS, ...ERP_PERMISSIONS].map((p) => [p.key, p.description]),
)

interface Draft {
  name: string
  description: string
  base_role: string
  data_scope: string
  permissions: Record<string, boolean>
  rights: MenuRights
}

function allMenus(groups: MenuGroup[]): MenuDef[] {
  return groups.flatMap((g) => g.menus)
}

function fullRow(menu: MenuDef, on: boolean): MenuRight {
  const row: MenuRight = { access: on }
  for (const a of menu.actions) row[a] = on
  return row
}

function draftOf(role: OrgRole | null, groups: MenuGroup[]): Draft {
  const menus = allMenus(groups)
  // Never limited by menu: it reaches everything, so that is what it shows.
  const rights: MenuRights = {}
  for (const m of menus) {
    rights[m.key] = role?.menu_rights
      ? { ...fullRow(m, false), ...role.menu_rights[m.key] }
      : fullRow(m, role !== null)
  }
  return {
    name: role?.name ?? '',
    description: role?.description ?? '',
    base_role: role?.base_role ?? 'employee',
    data_scope: role?.data_scope ?? 'self',
    permissions: { ...(role?.permissions ?? {}) },
    rights,
  }
}

export default function Roles() {
  const rolesQ = useQuery<OrgRole[]>('org-roles', () => api.get<OrgRole[]>('/roles'))
  const menusQ = useQuery<MenuGroup[]>('org-role-menus', () => api.get<MenuGroup[]>('/roles/menus'))
  const roles = rolesQ.data ?? []
  const groups = menusQ.data ?? []

  // 'new' while a role is being created.
  const [selected, setSelected] = useState<string | null>(null)
  const role = selected === 'new' ? null : roles.find((r) => r.id === selected) ?? roles[0] ?? null
  const creating = selected === 'new'

  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const baseline = useMemo(
    () => (groups.length ? draftOf(creating ? null : role, groups) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [role?.id, role, creating, groups],
  )
  useEffect(() => { setDraft(baseline); setError(null) }, [baseline])

  const dirty = Boolean(draft && baseline && JSON.stringify(draft) !== JSON.stringify(baseline))
  const isOwner = !creating && role?.base_role === 'owner'

  /* The name, description, level and scope live in a dialog rather than on the
     page: they are set once when a role is made and rarely touched after, and
     the menu matrix is what this page is for. A new role opens straight into
     it, since a role cannot be saved without a name. */
  const [detailsOpen, setDetailsOpen] = useState(false)

  function pick(id: string) {
    if (dirty && !window.confirm('Discard the changes you made to this role?')) return
    setSaved(false)
    setSelected(id)
    setDetailsOpen(id === 'new')
  }

  async function save() {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      const body: Record<string, unknown> = {
        name: draft.name,
        description: draft.description,
        base_role: draft.base_role,
        data_scope: draft.data_scope,
        permissions: draft.permissions,
      }
      if (!isOwner) body.menu_rights = draft.rights
      if (creating) {
        const made = await api.post<OrgRole>('/roles', body)
        setSelected(made.id)
      } else if (role) {
        await api.patch(`/roles/${role.id}`, body)
      }
      rolesQ.reload()
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the role.')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!role || role.is_builtin) return
    const held = role.member_count
    if (!window.confirm(`Delete the role “${role.name}”?${held ? `\n\n${held} ${held === 1 ? 'person holds' : 'people hold'} it and will fall back to their own permissions.` : ''}`)) return
    setBusy(true)
    try {
      await api.del(`/roles/${role.id}`)
      setSelected(null)
      rolesQ.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the role.')
    } finally {
      setBusy(false)
    }
  }

  if (rolesQ.error || menusQ.error) return <ErrorNote>{rolesQ.error ?? menusQ.error}</ErrorNote>
  if ((rolesQ.loading && !rolesQ.data) || (menusQ.loading && !menusQ.data) || !draft) return <Loading />

  return (
    <div className="page rp">
      {/* No page heading: the module tab above already reads "Role &
          Permission", and the role tabs below are the first thing to act on. */}
      <nav className="rp-tabs" aria-label="Roles">
        {roles.map((r) => {
          const on = !creating && role?.id === r.id
          return (
            <button key={r.id} type="button" className={`rp-tab${on ? ' is-on' : ''}`}
                    aria-current={on ? 'true' : undefined} onClick={() => pick(r.id)}>
              <span className={`rp-tab-badge level-${r.base_role}`} aria-hidden>{r.name.charAt(0).toUpperCase()}</span>
              <span className="rp-tab-text">
                <span className="rp-tab-name">{r.name}</span>
                <span className="rp-tab-meta">{r.member_count} {r.member_count === 1 ? 'person' : 'people'}</span>
              </span>
            </button>
          )
        })}
        <button type="button" className={`rp-tab rp-tab-new${creating ? ' is-on' : ''}`} onClick={() => pick('new')}>
          <IconPlus size={15} /> New role
        </button>
        <button type="button" className="rp-tab rp-tab-details" onClick={() => setDetailsOpen(true)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          </svg>
          Role details
        </button>
      </nav>

      {error && <div className="rp-error"><ErrorNote>{error}</ErrorNote></div>}

      {detailsOpen && (
        <Details draft={draft} setDraft={setDraft} role={role} creating={creating} busy={busy}
                 onDelete={() => { setDetailsOpen(false); void remove() }}
                 onClose={() => setDetailsOpen(false)} />
      )}

      <MenuMatrix
        groups={groups}
        draft={draft}
        setDraft={setDraft}
        locked={isOwner || busy}
      />

      {(dirty || saved) && (
        <div className={`rp-savebar${dirty ? '' : ' is-saved'}`} role="region" aria-label="Save changes">
          <span className="rp-savebar-text">
            {!dirty ? 'Saved.' : creating ? 'New role — not saved yet.'
              : role && role.member_count > 0
                ? `${role.member_count} ${role.member_count === 1 ? 'person holds' : 'people hold'} this role. Saving changes what they can do immediately.`
                : 'You have unsaved changes.'}
          </span>
          {dirty && (
            <>
              <button className="btn" disabled={busy} onClick={() => setDraft(baseline)}>Discard</button>
              <button className="btn btn-primary" disabled={busy || !draft.name.trim()} onClick={() => void save()}>
                {busy ? 'Saving…' : creating ? 'Create role' : 'Save changes'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- details --- */

function Details({
  draft, setDraft, role, creating, busy, onDelete, onClose,
}: {
  draft: Draft
  setDraft: (d: Draft) => void
  role: OrgRole | null
  creating: boolean
  busy: boolean
  onDelete: () => void
  onClose: () => void
}) {
  // A built-in's name and level are fixed; its rights and scope are not.
  const locked = !creating && Boolean(role?.is_builtin)
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="rp-modal-backdrop" onMouseDown={onClose}>
    <section className="rp-modal" role="dialog" aria-modal="true" aria-label="Role details"
             onMouseDown={(e) => e.stopPropagation()}>
      <header className="rp-modal-head">
        <div>
          <h2 className="rp-modal-title">{creating ? 'New role' : 'Role details'}</h2>
          <p className="rp-modal-sub">
            {creating ? 'Name the role and decide how far it can see. Choose its menus after.'
              : 'Changes here are saved with the menu permissions, from the bar at the bottom.'}
          </p>
        </div>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>
      <div className="rp-details-grid">
        <label className="rp-field">
          <span>Role name</span>
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })}
                 disabled={locked || busy} maxLength={80} placeholder="Finance Officer" />
        </label>
        <label className="rp-field rp-field-wide">
          <span>Description</span>
          <input value={draft.description} onChange={(e) => set({ description: e.target.value })}
                 disabled={busy} maxLength={300} placeholder="Approves and pays expense claims company-wide." />
        </label>
        <label className="rp-field">
          <span>Level</span>
          {locked ? (
            <input value={LEVEL_LABEL[draft.base_role] ?? draft.base_role} disabled />
          ) : (
            <select value={draft.base_role} onChange={(e) => set({ base_role: e.target.value })} disabled={busy}>
              {BASE_ROLES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
        </label>
        <label className="rp-field">
          <span>Can see</span>
          <select value={draft.data_scope} onChange={(e) => set({ data_scope: e.target.value })} disabled={busy}>
            {SCOPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      </div>
      <div className="rp-details-foot">
        {role && !creating && (
          <span className="rp-details-tags">
            <span className="rp-chip-static">{LEVEL_LABEL[role.base_role] ?? role.base_role}</span>
            {role.is_builtin && <span className="rp-chip-static">Built-in · name and level fixed</span>}
          </span>
        )}
        {role && !creating && !role.is_builtin && (
          <button className="btn btn-sm rp-delete" disabled={busy} onClick={onDelete}>Delete role</button>
        )}
        <button className="btn btn-primary btn-sm rp-modal-done" onClick={onClose}
                disabled={creating && !draft.name.trim()}>
          {creating ? 'Continue to menus' : 'Done'}
        </button>
      </div>
    </section>
    </div>
  )
}

/* -------------------------------------------------------------- matrix --- */

function MenuMatrix({
  groups, draft, setDraft, locked,
}: {
  groups: MenuGroup[]
  draft: Draft
  setDraft: (d: Draft) => void
  locked: boolean
}) {
  const [q, setQ] = useState('')
  const menus = allMenus(groups)

  function setRow(menu: MenuDef, row: MenuRight, perms?: Record<string, boolean>) {
    setDraft({
      ...draft,
      rights: { ...draft.rights, [menu.key]: row },
      permissions: perms ? { ...draft.permissions, ...perms } : draft.permissions,
    })
  }

  function setRowAll(menu: MenuDef, value: boolean) {
    setRow(menu, fullRow(menu, value), Object.fromEntries(menu.rights.map((k) => [k, value])))
  }

  function setEverything(value: boolean) {
    const rights: MenuRights = {}
    const perms: Record<string, boolean> = { ...draft.permissions }
    for (const m of menus) {
      rights[m.key] = fullRow(m, value)
      for (const k of m.rights) perms[k] = value
    }
    setDraft({ ...draft, rights, permissions: perms })
  }

  const needle = q.trim().toLowerCase()
  const matches = (m: MenuDef) =>
    !needle || m.label.toLowerCase().includes(needle) || m.key.includes(needle) ||
    m.rights.some((k) => (SHORT[k] ?? k).toLowerCase().includes(needle))
  const shown = groups
    .map((g) => ({ ...g, menus: g.menus.filter(matches) }))
    .filter((g) => g.menus.length > 0)

  return (
    <section className="card rp-matrix">
      <div className="rp-matrix-head">
        <span className="rp-matrix-icon" aria-hidden><IconShield size={18} /></span>
        <div className="rp-matrix-titles">
          <h2>Menus &amp; permissions</h2>
        </div>
        <div className="rp-matrix-tools">
          <label className="rp-search">
            <IconSearch size={15} />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
                   placeholder="Find a menu or permission" aria-label="Find a menu or permission" />
          </label>
          <button className="btn rp-outline" disabled={locked} onClick={() => setEverything(true)}>Allow all</button>
          <button className="btn rp-outline" disabled={locked} onClick={() => setEverything(false)}>Clear</button>
        </div>
      </div>


      <div className="rp-groups">
        {shown.length === 0 && <p className="rp-empty">No menu or permission matches “{q.trim()}”.</p>}
        {shown.map((g) => {
          const Icon = GROUP_ICON[g.key] ?? IconGrid
          const opened = g.menus.filter((m) => draft.rights[m.key]?.access).length
          return (
            <div className="rp-group is-open" key={g.key}>
              <div className="rp-group-title">
                <span className="rp-group-icon" aria-hidden><Icon size={16} /></span>
                <span className="rp-group-text">
                  <b>{g.label}</b>
                </span>
                <span className={`rp-group-count${opened === g.menus.length ? ' is-full' : opened === 0 ? ' is-none' : ''}`}>
                  {opened}/{g.menus.length} menus
                </span>
              </div>
              <div className="rp-table" role="table" aria-label={g.label}>
                <div className="rp-row rp-row-head" role="row">
                  <span role="columnheader">Menu</span>
                  <span role="columnheader" className="c">Access</span>
                  <span role="columnheader" className="c">View</span>
                  <span role="columnheader" className="c">Add</span>
                  <span role="columnheader" className="c">Edit</span>
                  <span role="columnheader" className="c">Delete</span>
                  <span role="columnheader">Other rights</span>
                  <span role="columnheader" className="r">Select all</span>
                </div>
                {g.menus.map((m) => (
                  <MenuRow key={m.key} menu={m} icon={<Icon size={15} />} row={draft.rights[m.key] ?? { access: false }}
                           perms={draft.permissions} locked={locked} setRow={setRow} setRowAll={setRowAll} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function MenuRow({
  menu, icon, row, perms, locked, setRow, setRowAll,
}: {
  menu: MenuDef
  icon: ReactNode
  row: MenuRight
  perms: Record<string, boolean>
  locked: boolean
  setRow: (menu: MenuDef, row: MenuRight, perms?: Record<string, boolean>) => void
  setRowAll: (menu: MenuDef, value: boolean) => void
}) {
  const off = !row.access
  return (
    <div className={`rp-row${menu.parent ? ' is-child' : ''}${off ? ' is-off' : ''}`} role="row">
      <span className="rp-menu" role="cell">
        <span className="rp-menu-icon" aria-hidden>{icon}</span>
        <span className="rp-menu-text">
          <span className="rp-menu-name">{menu.label}</span>
          {menu.note && <span className="rp-menu-path">{menu.note}</span>}
        </span>
      </span>

      <span className="c" role="cell">
        <button type="button" role="switch" aria-checked={row.access} aria-label={`Access to ${menu.label}`}
                className={`rp-switch${row.access ? ' is-on' : ''}`} disabled={locked}
                onClick={() => {
                  // Closing a menu takes everything inside it with it.
                  if (row.access) setRow(menu, fullRow(menu, false), Object.fromEntries(menu.rights.map((k) => [k, false])))
                  else setRow(menu, { ...row, access: true })
                }}>
          <span className="rp-switch-knob" />
        </button>
      </span>

      {/* View is what Access grants: a menu you can open is one you can read. */}
      <span className="c" role="cell">
        <input type="checkbox" className="rp-check" checked={row.access} disabled readOnly
               aria-label={`View ${menu.label}`} title="Comes with Access" />
      </span>

      {ACTIONS.map((a) => (
        <span className="c" role="cell" key={a}>
          {menu.actions.includes(a) ? (
            <input type="checkbox" className="rp-check" checked={Boolean(row[a])} disabled={locked || off}
                   aria-label={`${a} in ${menu.label}`}
                   onChange={(e) => setRow(menu, { ...row, [a]: e.target.checked })} />
          ) : <span className="rp-na" title="Nothing to change on this menu">—</span>}
        </span>
      ))}

      <span className="rp-rights" role="cell">
        {menu.rights.length === 0 && <span className="rp-na">—</span>}
        {menu.rights.map((k) => (
          <button type="button" key={k} className={`rp-chip${perms[k] ? ' is-on' : ''}`}
                  aria-pressed={Boolean(perms[k])} disabled={locked || off} title={DESCRIPTION[k]}
                  onClick={() => setRow(menu, row, { [k]: !perms[k] })}>
            {SHORT[k] ?? k}
          </button>
        ))}
      </span>

      <span className="r rp-selectall" role="cell">
        <button type="button" className="rp-mini" disabled={locked} onClick={() => setRowAll(menu, true)}>All</button>
        <button type="button" className="rp-mini" disabled={locked} onClick={() => setRowAll(menu, false)}>None</button>
      </span>
    </div>
  )
}
