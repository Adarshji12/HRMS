/* CRM Settings — everything the CRM is configured with, in one place.
 *
 * Five tabs:
 *   General      how a new lead is assigned, and the renewal and ticket rules
 *   Leads Master the lists a lead is described with — statuses, sources,
 *                geography, industry, products, plans, call dispositions
 *   Access       which CRM menus each role opens (edited on Role & Permission)
 *   Visit Master the kinds of field visit, and how visits are numbered
 *   Quotation    numbering, validity and the default terms
 *
 * The master lists are the same tables the Master menu shows — one data
 * source, reachable from both — so a status added here is the status the
 * Master menu lists.
 */

import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import '../../styles/crm.css'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { canAdminister, useAuth } from '../../lib/auth'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import {
  IconBuilding,
  IconCalendar,
  IconCheck,
  IconGear,
  IconGlobe,
  IconLifebuoy,
  IconPin,
  IconSheet,
  IconShield,
  IconStar,
  IconUsers,
} from '../../components/Icons'
import { crm, crmError, type CrmSettings as Settings } from './api'
import { CrmPage, Field, OwnerSelect } from './parts'
import DistrictMapping from './DistrictMapping'
import CityMapping from './CityMapping'
import { LISTS, MasterTable } from '../masters/masterKit'
import type { OrgRole } from '../hrms/roles/Roles'

type Glyph = (p: { size?: number }) => JSX.Element

const TABS: Array<{ key: TabKey; label: string; icon: Glyph }> = [
  { key: 'general', label: 'General', icon: IconGear },
  { key: 'leads', label: 'Leads Master', icon: IconUsers },
  { key: 'access', label: 'Access', icon: IconShield },
  { key: 'visits', label: 'Visit Master', icon: IconPin },
  { key: 'quotation', label: 'Quotation', icon: IconSheet },
]

type TabKey = 'general' | 'leads' | 'access' | 'visits' | 'quotation'

/* The Leads Master sub-tabs, in the order a lead is described. Each is a
   master list from masterKit; a kind missing there is simply not shown. */
const LEAD_LISTS: Array<{ kind: string; label: string; icon: Glyph }> = [
  { kind: 'statuses', label: 'Lead Statuses', icon: IconStar },
  { kind: 'sources', label: 'Lead Sources', icon: IconGlobe },
  { kind: 'countries', label: 'Country Master', icon: IconGlobe },
  { kind: 'states', label: 'State Master', icon: IconPin },
  { kind: 'districts', label: 'District Master', icon: IconPin },
  { kind: 'cities', label: 'City Master', icon: IconBuilding },
  { kind: 'industries', label: 'Industry Type', icon: IconBuilding },
  { kind: 'products', label: 'Product / Service', icon: IconSheet },
  { kind: 'plans', label: 'Plan Master', icon: IconCalendar },
  { kind: 'dispositions', label: 'Call Disposition', icon: IconLifebuoy },
]

const listFor = (kind: string) => LISTS.find((list) => list.kind === kind)

export default function CrmSettings() {
  const { user } = useAuth()
  const [tab, setTab] = useState<TabKey>('general')

  if (!canAdminister(user)) {
    return (
      <CrmPage title="CRM Settings">
        <section className="card">
          <EmptyState
            icon={<IconGear size={22} />}
            title="CRM configuration is administrator-only"
            body="Stages, sources, products and assignment rules decide how everybody's pipeline behaves, so they are not edited from a salesperson's account. You can still use every dropdown they define."
          />
        </section>
      </CrmPage>
    )
  }

  return (
    // No page heading: the top bar already names the page, so the tabs lead.
    <div className="crm">
      <nav className="cs-tabs" aria-label="CRM settings sections">
        {TABS.map((entry) => {
          const Icon = entry.icon
          return (
            <button
              key={entry.key}
              type="button"
              className={`cs-tab${tab === entry.key ? ' is-on' : ''}`}
              aria-current={tab === entry.key ? 'page' : undefined}
              onClick={() => setTab(entry.key)}
            >
              <Icon size={15} /> {entry.label}
            </button>
          )
        })}
      </nav>

      {tab === 'general' && <GeneralPanel />}
      {tab === 'leads' && <LeadsMaster />}
      {tab === 'access' && <AccessPanel />}
      {tab === 'visits' && <VisitMaster />}
      {tab === 'quotation' && (
        <SettingsForm
          title="Quotation"
          hint="Prefixes apply from the next quotation onwards. Numbers already issued keep the prefix they were issued with."
          fields={['quotation_prefix', 'quotation_validity_days', 'quotation_terms']}
        />
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- general --- */

function GeneralPanel() {
  return (
    <div className="cs-stack">
      <AssignmentCard />
      <SettingsForm
        title="Support & renewals"
        hint="How support tickets are numbered, and how early a customer shows as due for renewal."
        fields={['ticket_prefix', 'renewal_window_days']}
      />
    </div>
  )
}

/** Who a new lead goes to. Saved as each control changes, like a switch. */
function AssignmentCard() {
  const settings = useQuery<Settings>('crm-settings', () => crm.settings())
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const current = settings.data

  async function patch(body: Partial<Settings>) {
    setError(null)
    try {
      await crm.saveSettings(body)
      settings.reload()
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(crmError(err, 'That setting could not be saved'))
    }
  }

  if (settings.loading) return <Loading />
  if (!current) return <ErrorNote>{crmError(settings.cause, 'Could not read the settings')}</ErrorNote>

  return (
    <section className="card cs-card">
      <CardHead
        icon={<IconUsers size={16} />}
        title="Lead assignment"
        hint="Who a lead that arrives on its own is given to. Leads added by hand keep whoever you pick on the form."
        badge={saved ? <span className="crm-state crm-state-good">Saved</span> : undefined}
      />
      {error && <div className="cs-pad"><ErrorNote>{error}</ErrorNote></div>}
      <div className="crm-grid-2 cs-pad">
        <Field label="Assignment rule">
          <select
            value={current.assignment_rule}
            onChange={(event) => patch({ assignment_rule: event.target.value as Settings['assignment_rule'] })}
          >
            <option value="unassigned">Leave unassigned — a manager hands them out</option>
            <option value="fixed">Always to one person</option>
            <option value="round_robin">Round robin across a pool</option>
          </select>
        </Field>

        {current.assignment_rule === 'fixed' && (
          <Field label="Send every lead to">
            <OwnerSelect
              value={current.default_owner_id ?? ''}
              onChange={(value) => patch({ default_owner_id: value || null })}
            />
          </Field>
        )}

        {current.assignment_rule === 'round_robin' && (
          <Field label="Add somebody to the pool" hint={`Currently ${current.assignment_pool.length} in the rotation.`}>
            <OwnerSelect
              value=""
              onChange={(value) =>
                value &&
                !current.assignment_pool.includes(value) &&
                patch({ assignment_pool: [...current.assignment_pool, value] })
              }
              placeholder="Pick somebody to add"
            />
          </Field>
        )}
      </div>

      {current.assignment_rule === 'round_robin' && current.assignment_pool.length > 0 && (
        <div className="cs-pool">
          {current.assignment_pool.map((id) => (
            <span className="crm-pill" key={id}>
              <PoolMember id={id} />
              <button
                className="link-btn"
                aria-label="Remove from the pool"
                onClick={() => patch({ assignment_pool: current.assignment_pool.filter((entry) => entry !== id) })}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

/** Resolves one pool member's name. Reads the same roster the pickers do, so
 *  the name comes out of cache rather than a request per chip. */
function PoolMember({ id }: { id: string }) {
  const team = useQuery<Array<{ id: string; full_name: string }>>('crm-team', () =>
    api.get<Array<{ id: string; full_name: string }>>('/admin/employees').catch(() => []),
  )
  const person = (team.data ?? []).find((member) => member.id === id)
  return <>{person?.full_name ?? 'Unknown user'}</>
}

/* ----------------------------------------------------------- leads master --- */

function LeadsMaster() {
  const available = LEAD_LISTS.filter((entry) => listFor(entry.kind))
  const [kind, setKind] = useState(available[0]?.kind ?? '')
  const list = listFor(kind)
  return (
    <div className="cs-stack">
      <nav className="cs-subtabs" aria-label="Leads master lists">
        {available.map((entry) => {
          const Icon = entry.icon
          return (
            <button
              key={entry.kind}
              type="button"
              className={`cs-subtab${kind === entry.kind ? ' is-on' : ''}`}
              aria-current={kind === entry.kind ? 'true' : undefined}
              onClick={() => setKind(entry.kind)}
            >
              <Icon size={14} /> {entry.label}
            </button>
          )
        })}
      </nav>
      {/* Districts get the state-by-state mapping view rather than a flat list:
          786 rows only make sense grouped under their state. */}
      {kind === 'districts' ? <DistrictMapping />
        : kind === 'cities' ? <CityMapping />
          : list && <MasterTable key={list.kind} list={list} />}
    </div>
  )
}

/* ----------------------------------------------------------- visit master --- */

function VisitMaster() {
  const list = listFor('visit-types')
  return (
    <div className="cs-stack">
      {list && <MasterTable list={list} />}
      <SettingsForm
        title="Visit numbering"
        hint="Applies from the next visit onwards; visits already booked keep their numbers."
        fields={['visit_prefix']}
      />
    </div>
  )
}

/* ----------------------------------------------------------------- access --- */

interface MenuDef { key: string; label: string; actions: string[] }
interface MenuGroup { key: string; label: string; menus: MenuDef[] }

/** Which CRM menus each role opens — read here, changed on Role & Permission,
 *  where the rest of each role's rights are. */
function AccessPanel() {
  const roles = useQuery<OrgRole[]>('org-roles', () => api.get<OrgRole[]>('/roles'))
  const menus = useQuery<MenuGroup[]>('org-role-menus', () => api.get<MenuGroup[]>('/roles/menus'))

  if (roles.error || menus.error) return <ErrorNote>{roles.error ?? menus.error}</ErrorNote>
  if (!roles.data || !menus.data) return <Loading />

  const crmMenus = menus.data.find((group) => group.key === 'crm')?.menus ?? []
  const opens = (role: OrgRole, key: string) =>
    role.base_role === 'owner' || role.menu_rights === null || Boolean(role.menu_rights?.[key]?.access)

  return (
    <section className="card cs-card">
      <CardHead
        icon={<IconShield size={16} />}
        title="Who can use the CRM"
        hint="Which CRM menus each role opens. A role not yet limited by menu opens all of them."
        badge={<Link className="btn btn-sm" to="/roles">Edit in Role &amp; Permission</Link>}
      />
      <div className="table-wrap">
        <table className="cs-access">
          <thead>
            <tr>
              <th>Role</th>
              {crmMenus.map((menu) => <th key={menu.key} className="c">{menu.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {roles.data.map((role) => (
              <tr key={role.id}>
                <td>
                  <span className="crm-strong">{role.name}</span>
                  <span className="cs-role-meta">
                    {role.member_count} {role.member_count === 1 ? 'person' : 'people'}
                    {role.base_role === 'owner' ? ' · always everything' : role.menu_rights === null ? ' · not limited' : ''}
                  </span>
                </td>
                {crmMenus.map((menu) => (
                  <td key={menu.key} className="c">
                    {opens(role, menu.key)
                      ? <span className="cs-yes" aria-label="Opens"><IconCheck size={14} /></span>
                      : <span className="cs-no" aria-label="Closed">—</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/* ----------------------------------------------------------- shared parts --- */

function CardHead({ icon, title, hint, badge }: { icon: ReactNode; title: string; hint?: string; badge?: ReactNode }) {
  return (
    <div className="cs-card-head">
      <span className="cs-card-icon" aria-hidden>{icon}</span>
      <div className="cs-card-titles">
        <h2>{title}</h2>
        {hint && <p>{hint}</p>}
      </div>
      {badge && <div className="cs-card-badge">{badge}</div>}
    </div>
  )
}

type FieldKey = 'quotation_prefix' | 'quotation_validity_days' | 'quotation_terms' | 'visit_prefix'
  | 'ticket_prefix' | 'renewal_window_days'

/** A card of settings saved together with one button. */
function SettingsForm({ title, hint, fields }: { title: string; hint: string; fields: FieldKey[] }) {
  const settings = useQuery<Settings>('crm-settings', () => crm.settings())
  const [draft, setDraft] = useState<Partial<Settings>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const current = settings.data
  const value = <K extends keyof Settings>(key: K): Settings[K] | undefined =>
    (draft[key] ?? current?.[key]) as Settings[K] | undefined
  const set = (patch: Partial<Settings>) => setDraft((d) => ({ ...d, ...patch }))

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await crm.saveSettings(draft)
      setDraft({})
      settings.reload()
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(crmError(err, 'Those settings could not be saved'))
    } finally {
      setBusy(false)
    }
  }

  if (settings.loading) return <Loading />
  if (!current) return <ErrorNote>{crmError(settings.cause, 'Could not read the settings')}</ErrorNote>

  const control: Record<FieldKey, ReactNode> = {
    quotation_prefix: (
      <Field label="Quotation prefix" hint={`e.g. ${value('quotation_prefix')}-2026-0001`}>
        <input value={value('quotation_prefix') ?? ''} onChange={(e) => set({ quotation_prefix: e.target.value })} />
      </Field>
    ),
    quotation_validity_days: (
      <Field label="Quotation validity (days)">
        <input type="number" min={1} max={365} value={value('quotation_validity_days') ?? 15}
               onChange={(e) => set({ quotation_validity_days: Number(e.target.value) })} />
      </Field>
    ),
    quotation_terms: (
      <Field label="Default terms &amp; conditions" wide hint="Printed under the totals on a new quotation.">
        <textarea rows={4} value={value('quotation_terms') ?? ''} onChange={(e) => set({ quotation_terms: e.target.value })} />
      </Field>
    ),
    visit_prefix: (
      <Field label="Visit prefix" hint={`e.g. ${value('visit_prefix')}-0001`}>
        <input value={value('visit_prefix') ?? ''} onChange={(e) => set({ visit_prefix: e.target.value })} />
      </Field>
    ),
    ticket_prefix: (
      <Field label="Support ticket prefix" hint={`e.g. ${value('ticket_prefix')}-00001`}>
        <input value={value('ticket_prefix') ?? ''} onChange={(e) => set({ ticket_prefix: e.target.value })} />
      </Field>
    ),
    renewal_window_days: (
      <Field label="Renewal window (days)" hint="How early a customer starts showing as renewal due.">
        <input type="number" min={1} max={365} value={value('renewal_window_days') ?? 30}
               onChange={(e) => set({ renewal_window_days: Number(e.target.value) })} />
      </Field>
    ),
  }
  const dirty = Object.keys(draft).length > 0

  return (
    <section className="card cs-card">
      <CardHead
        icon={<IconSheet size={16} />}
        title={title}
        hint={hint}
        badge={saved ? <span className="crm-state crm-state-good">Saved</span> : undefined}
      />
      {error && <div className="cs-pad"><ErrorNote>{error}</ErrorNote></div>}
      <div className="crm-grid-2 cs-pad">
        {fields.map((key) => <div key={key} className={key === 'quotation_terms' ? 'crm-form-wide' : undefined}>{control[key]}</div>)}
      </div>
      <div className="cs-foot">
        {dirty && <button className="link-btn" onClick={() => setDraft({})}>Discard</button>}
        <button className="btn btn-primary" onClick={save} disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </section>
  )
}
