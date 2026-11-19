/* CRM Settings — everything the CRM is configured with, in one place.
 *
 * Five tabs:
 *   General      how a new lead is assigned, and the renewal and ticket rules
 *   Leads Master the lists a lead is described with — statuses, sources,
 *                geography, industry, products, plans, call dispositions
 *   Access       which CRM menus each role opens (edited on Role & Permission)
 *   Visit Master the kinds of field visit, and how visits are numbered
 *   Quotation    style, letterhead, numbering, payment, terms and stamp
 *                (QuotationSetup.tsx)
 *
 * The master lists are the same tables the Master menu shows — one data
 * source, reachable from both — so a status added here is the status the
 * Master menu lists.
 */

import { useEffect, useState, type ReactNode } from 'react'
import '../../styles/crm.css'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { canAdminister, useAuth } from '../../lib/auth'
import { Avatar, EmptyState, ErrorNote, Loading } from '../../components/ui'
import {
  IconGear,
  IconSheet,
  IconShield,
  IconUsers,
} from '../../components/Icons'
import { crm, crmError, type AccessMember, type AccessScope, type CrmSettings as Settings } from './api'
import { CrmPage, Field, OwnerSelect } from './parts'
import QuotationSetupPanel from './QuotationSetup'

type Glyph = (p: { size?: number }) => JSX.Element

const TABS: Array<{ key: TabKey; label: string; icon: Glyph }> = [
  { key: 'general', label: 'General', icon: IconGear },
  { key: 'access', label: 'Access', icon: IconShield },
  { key: 'quotation', label: 'Quotation', icon: IconSheet },
]

/* The master lists (lead statuses, sources, geography, products, visit types…)
   are edited on the Master page, not here — one place for each list. */
type TabKey = 'general' | 'access' | 'quotation'


export default function CrmSettings() {
  const { user } = useAuth()
  const [tab, setTab] = useState<TabKey>('general')
  const [unsaved, setUnsaved] = useState(false)

  if (!canAdminister(user)) {
    return (
      <CrmPage title="CRM Settings">
        <section className="card">
          <EmptyState
            icon={<IconGear size={22} />}
            title="CRM configuration is administrator-only"
            body="Stages, sources and assignment rules decide how everybody's pipeline behaves, so they are not edited from a salesperson's account. You can still use every dropdown they define."
          />
        </section>
      </CrmPage>
    )
  }

  return (
    // No page heading: the top bar already names the page, so the tabs lead.
    <div className="crm cs-page">
      <div className="cs-topbar">
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
        {tab === 'general' && (
          <span className={`cs-status${unsaved ? ' is-dirty' : ''}`} role="status">
            <span className="cs-status-dot" aria-hidden /> {unsaved ? 'Unsaved changes' : 'All changes saved'}
          </span>
        )}
      </div>

      {tab === 'general' && <GeneralPanel onDirty={setUnsaved} />}
      {tab === 'access' && <AccessPanel />}
      {tab === 'quotation' && <QuotationSetupPanel />}
    </div>
  )
}

/* ---------------------------------------------------------------- general --- */

function GeneralPanel({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  return (
    <div className="cs-stack">
      <AssignmentCard />
      <SettingsForm
        onDirty={onDirty}
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
      <div className="cs-fields">
        <CsField label="Assignment rule" hint={RULE_HINTS[current.assignment_rule]}>
          <select
            value={current.assignment_rule}
            onChange={(event) => patch({ assignment_rule: event.target.value as Settings['assignment_rule'] })}
          >
            <option value="unassigned">Leave unassigned — a manager hands them out</option>
            <option value="fixed">Always to one person</option>
            <option value="round_robin">Round robin across a pool</option>
          </select>
        </CsField>

        {current.assignment_rule === 'fixed' && (
          <CsField label="Send every lead to" hint="Every lead that arrives on its own goes to this person.">
            <OwnerSelect
              value={current.default_owner_id ?? ''}
              onChange={(value) => patch({ default_owner_id: value || null })}
            />
          </CsField>
        )}

        {current.assignment_rule === 'round_robin' && (
          <CsField
            label="Add somebody to the pool"
            aside={<span className="cs-chip">Currently {current.assignment_pool.length} in the rotation</span>}
            hint="Select a team member to append them to the active rotation."
          >
            <OwnerSelect
              value=""
              onChange={(value) =>
                value &&
                !current.assignment_pool.includes(value) &&
                patch({ assignment_pool: [...current.assignment_pool, value] })
              }
              placeholder="Pick somebody to add"
            />
          </CsField>
        )}
      </div>

      {current.assignment_rule === 'round_robin' && current.assignment_pool.length > 0 && (
        <div className="cs-rotation">
          <div className="cs-rotation-head">
            <span className="cs-label">Active rotation sequence</span>
            <span className="cs-aside">Click × to remove from pool</span>
          </div>
          <div className="cs-pool">
            {current.assignment_pool.map((id, index) => (
              <PoolChip
                key={id}
                id={id}
                position={index + 1}
                onRemove={() => patch({ assignment_pool: current.assignment_pool.filter((entry) => entry !== id) })}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

const RULE_HINTS: Record<Settings['assignment_rule'], string> = {
  unassigned: 'New leads wait in the pool until a manager hands them out.',
  fixed: 'Every lead that arrives on its own goes to one person.',
  round_robin: 'Distributes incoming leads equally in sequential order.',
}

/** A label row (with an optional note on the right), the control, and a hint. */
function CsField({ label, aside, hint, children }: { label: string; aside?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="cs-field">
      <div className="cs-field-top">
        <span className="cs-label">{label}</span>
        {aside}
      </div>
      {children}
      {hint && <span className="cs-hint">{hint}</span>}
    </div>
  )
}

/** One person in the rotation: avatar, name, position, and a remove button.
 *  Reads the same roster the pickers do, so the name comes out of cache rather
 *  than a request per chip. */
function PoolChip({ id, position, onRemove }: { id: string; position: number; onRemove: () => void }) {
  const team = useQuery<Array<{ id: string; full_name: string }>>('crm-team', () =>
    api.get<Array<{ id: string; full_name: string }>>('/admin/employees').catch(() => []),
  )
  const name = (team.data ?? []).find((member) => member.id === id)?.full_name ?? 'Unknown user'
  return (
    <span className="cs-member">
      <Avatar name={name} small />
      <span className="cs-member-name">{name}</span>
      <span className="cs-member-pos">#{position}</span>
      <button type="button" className="cs-member-x" aria-label={`Remove ${name} from the pool`} onClick={onRemove}>×</button>
    </span>
  )
}

/* ----------------------------------------------------------------- access --- */


type AccessTab = 'lead' | 'customer'

/** Settings > Access: how much of the lead and customer book each person sees,
 *  and which menus each role opens. */
function AccessPanel() {
  const [tab, setTab] = useState<AccessTab>('lead')
  const tabs: Array<{ key: AccessTab; label: string; icon: Glyph }> = [
    { key: 'lead', label: 'Lead Access', icon: IconShield },
    { key: 'customer', label: 'Customer Access', icon: IconUsers },
  ]
  return (
    <>
      <nav className="cs-tabs cs-subtabs" aria-label="Access sections">
        {tabs.map((entry) => {
          const Icon = entry.icon
          return (
            <button key={entry.key} type="button" className={`cs-tab${tab === entry.key ? ' is-on' : ''}`}
                    aria-current={tab === entry.key ? 'page' : undefined} onClick={() => setTab(entry.key)}>
              <Icon size={15} /> {entry.label}
            </button>
          )
        })}
      </nav>
      <PeopleAccessPanel kind={tab} />
    </>
  )
}

const SCOPE_WORDS = {
  lead: { noun: 'lead', plural: 'leads', own: 'Own Leads Only', all: 'All Leads', assign: 'All Leads + Assign' },
  customer: { noun: 'customer', plural: 'customers', own: 'Own Customers Only', all: 'All Customers', assign: 'All Customers + Reassign' },
} as const

/** One row per person: pick how much of the book they see. Saved on click. */
function PeopleAccessPanel({ kind }: { kind: 'lead' | 'customer' }) {
  const people = useQuery<AccessMember[]>('crm-access', () => crm.access())
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const words = SCOPE_WORDS[kind]

  if (people.error) return <ErrorNote>{people.error}</ErrorNote>
  if (!people.data) return <Loading />

  const scopeOf = (person: AccessMember) => (kind === 'lead' ? person.lead_scope : person.customer_scope)
  const seeAll = people.data.filter((p) => p.is_admin || scopeOf(p) === 'all' || scopeOf(p) === 'all_assign').length

  async function choose(person: AccessMember, scope: AccessScope) {
    setSaving(person.user_id)
    setError(null)
    try {
      await crm.setAccess(person.user_id, kind === 'lead' ? { lead_scope: scope } : { customer_scope: scope })
      people.reload()
    } catch (err) {
      setError(crmError(err, 'That could not be saved'))
    } finally {
      setSaving(null)
    }
  }

  const options: Array<[AccessScope, string]> = [['own', words.own], ['all', words.all], ['all_assign', words.assign]]

  return (
    <section className="card cs-card">
      <CardHead
        icon={kind === 'lead' ? <IconShield size={16} /> : <IconUsers size={16} />}
        title={`${kind === 'lead' ? 'Lead' : 'Customer'} Access`}
        hint={kind === 'lead'
          ? 'How much of the pipeline each person sees. Nobody loses sight of their own leads.'
          : 'How much of the customer book each person sees, by account manager. Nobody loses sight of their own accounts.'}
        badge={<span className="muted">{seeAll} of {people.data.length} see all {words.plural}</span>}
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="table-wrap">
        <table className="cs-access cs-people">
          <thead>
            <tr>
              <th>Member</th>
              <th>Team</th>
              <th className="c">{kind === 'lead' ? 'Own Leads' : 'Own Customers'}</th>
              <th>{kind === 'lead' ? 'Lead' : 'Customer'} Visibility</th>
            </tr>
          </thead>
          <tbody>
            {people.data.map((person) => {
              const scope = scopeOf(person)
              return (
                <tr key={person.user_id}>
                  <td>
                    <span className="crm-strong">{person.name}</span>
                    <span className="cs-role-meta">{person.email}</span>
                  </td>
                  <td>{person.team ?? <span className="muted">—</span>}</td>
                  <td className="c">{kind === 'lead' ? person.own_leads : person.own_customers}</td>
                  <td>
                    {person.is_admin ? (
                      <span className="muted">Admin — always sees every {words.noun}</span>
                    ) : (
                      <>
                        <div className="cs-seg" role="radiogroup" aria-label={`${person.name}: ${words.noun} visibility`}>
                          {options.map(([value, label]) => (
                            <button key={value} type="button" role="radio" aria-checked={scope === value}
                                    className={scope === value ? 'is-on' : ''} disabled={saving === person.user_id}
                                    onClick={() => scope !== value && choose(person, value)}>
                              {label}
                            </button>
                          ))}
                        </div>
                        {scope === null && (
                          <span className="cs-role-meta">
                            Not set — sees {kind === 'lead' ? person.lead_default : person.customer_default} {words.plural}
                          </span>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="muted cs-foot">
        Takes effect on the member's next request — no re-login needed.
        {kind === 'customer' ? ' Covers My Customers, the support desk and every customer report.' : ''}
        {' '}"{words.all}" lets someone see every {words.noun} but not hand them to anyone else; "{words.assign}" also lets them.
      </p>
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
function SettingsForm({ title, hint, fields, onDirty }: { title: string; hint: string; fields: FieldKey[]; onDirty?: (dirty: boolean) => void }) {
  const settings = useQuery<Settings>('crm-settings', () => crm.settings())
  const [draft, setDraft] = useState<Partial<Settings>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const current = settings.data
  const value = <K extends keyof Settings>(key: K): Settings[K] | undefined =>
    (draft[key] ?? current?.[key]) as Settings[K] | undefined
  const set = (patch: Partial<Settings>) => setDraft((d) => ({ ...d, ...patch }))
  const dirty = Object.keys(draft).length > 0
  useEffect(() => { onDirty?.(dirty) }, [dirty, onDirty])

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
        <input placeholder="QT" value={value('quotation_prefix') ?? ''} onChange={(e) => set({ quotation_prefix: e.target.value })} />
      </Field>
    ),
    quotation_validity_days: (
      <Field label="Quotation validity (days)">
        <input placeholder="15" type="number" min={1} max={365} value={value('quotation_validity_days') ?? 15}
               onChange={(e) => set({ quotation_validity_days: Number(e.target.value) })} />
      </Field>
    ),
    quotation_terms: (
      <Field label="Default terms &amp; conditions" wide hint="Printed under the totals on a new quotation.">
        <textarea placeholder="e.g. Payment within 15 days of invoice. Prices exclusive of GST." rows={4} value={value('quotation_terms') ?? ''} onChange={(e) => set({ quotation_terms: e.target.value })} />
      </Field>
    ),
    visit_prefix: (
      <Field label="Visit prefix" hint={`e.g. ${value('visit_prefix')}-0001`}>
        <input placeholder="VST" value={value('visit_prefix') ?? ''} onChange={(e) => set({ visit_prefix: e.target.value })} />
      </Field>
    ),
    ticket_prefix: (
      <CsField
        label="Support ticket prefix"
        aside={<span className="cs-aside">Live format: <span className="cs-chip">{value('ticket_prefix') || 'TKT'}-00001</span></span>}
        hint={<>e.g. <code>{value('ticket_prefix') || 'TKT'}-00001</code> · Automatically prepended to new tickets.</>}
      >
        <input placeholder="TKT" value={value('ticket_prefix') ?? ''} onChange={(e) => set({ ticket_prefix: e.target.value })} />
      </CsField>
    ),
    renewal_window_days: (
      <CsField
        label="Renewal window (days)"
        aside={<span className="cs-aside">Range: 1–365</span>}
        hint={<>Customers show as due <strong>{value('renewal_window_days') ?? 30} days</strong> before expiry.</>}
      >
        <span className="cs-suffixed">
          <input placeholder="30" type="number" min={1} max={365} value={value('renewal_window_days') ?? 30}
                 onChange={(e) => set({ renewal_window_days: Number(e.target.value) })} />
          <span className="cs-suffix" aria-hidden>days</span>
        </span>
      </CsField>
    ),
  }

  return (
    <section className="card cs-card">
      <CardHead
        icon={<IconSheet size={16} />}
        title={title}
        hint={hint}
        badge={saved ? <span className="crm-state crm-state-good">Saved</span> : undefined}
      />
      {error && <div className="cs-pad"><ErrorNote>{error}</ErrorNote></div>}
      <div className="cs-fields">
        {fields.map((key) => <div key={key} className={key === 'quotation_terms' ? 'crm-form-wide' : undefined}>{control[key]}</div>)}
      </div>
      <div className="cs-foot">
        <span className="cs-foot-note">Changes apply immediately to newly created leads and tickets.</span>
        <span className="cs-push" />
        {dirty && <button className="link-btn" onClick={() => setDraft({})}>Discard</button>}
        <button className="btn btn-primary" onClick={save} disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </section>
  )
}
