/* CRM Settings — how a captured lead is assigned and how documents are numbered.
 *
 * The master lists (stages, sources, products, geography, the sales masters)
 * used to live here as tabs. They moved to the Master menu, beside every other
 * reference list in the workspace, so a tab here only points there.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import '../../styles/crm.css'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { canAdminister, useAuth } from '../../lib/auth'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import {
  IconGear,
  IconGlobe,
  IconSheet,
} from '../../components/Icons'
import { crm, crmError, type CrmSettings as Settings } from './api'
import { CrmPage, Field, OwnerSelect } from './parts'

const TABS = [
  { key: 'intake', label: 'Lead Intake', icon: IconGlobe },
  { key: 'documents', label: 'Quotation & numbering', icon: IconSheet },
] as const

type TabKey = (typeof TABS)[number]['key']

export default function CrmSettings() {
  const { user } = useAuth()
  const [tab, setTab] = useState<TabKey>('intake')

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
    <CrmPage title="CRM Settings" subtitle="Lead capture, assignment rules and document numbering">
      <p className="crm-field-hint" style={{ marginBottom: 12 }}>
        Lead statuses, sources, products, geography and the sales masters are in the{' '}
        <Link to="/masters">Master</Link> menu.
      </p>
      <div className="crm-tabs">
        {TABS.map((entry) => {
          const Glyph = entry.icon
          return (
            <button
              key={entry.key}
              className={`crm-tab${tab === entry.key ? ' crm-tab-on' : ''}`}
              onClick={() => setTab(entry.key)}
            >
              <Glyph size={14} /> {entry.label}
            </button>
          )
        })}
      </div>

      {tab === 'intake' && <IntakePanel />}
      {tab === 'documents' && <DocumentsPanel />}
    </CrmPage>
  )
}

/* ----------------------------------------------------------------- intake --- */

function IntakePanel() {
  const settings = useQuery<Settings>('crm-settings', () => crm.settings())
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)

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

  async function rotate() {
    setError(null)
    try {
      await crm.rotateIntake()
      settings.reload()
    } catch (err) {
      setError(crmError(err, 'A new link could not be issued'))
    }
  }

  if (settings.loading) return <Loading />
  if (!current) return <ErrorNote>{crmError(settings.cause, 'Could not read the settings')}</ErrorNote>

  return (
    <>
      <section className="card" style={{ marginBottom: 14 }}>
        <div className="crm-panel-head">
          <div>
            <h2 className="crm-panel-title">Lead capture</h2>
            <p className="crm-field-hint" style={{ maxWidth: 640 }}>
              A URL your ad platform or website form posts to. Whoever holds it can create leads in
              this workspace, so treat it as a secret — and rotate it if it ever leaks.
            </p>
          </div>
          {saved && <span className="crm-state crm-state-good crm-panel-link">Saved</span>}
        </div>

        {error && (
          <div style={{ padding: '0 16px 12px' }}>
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        <div className="crm-log">
          <label className="crm-check">
            <input
              type="checkbox"
              checked={current.intake_enabled}
              onChange={(event) => patch({ intake_enabled: event.target.checked })}
            />
            Accept captured leads from outside this console
          </label>

          {current.intake_url ? (
            <>
              <div className="crm-token">
                <span>{current.intake_url}</span>
                <button
                  className="btn btn-sm crm-push"
                  onClick={async () => {
                    await navigator.clipboard?.writeText(current.intake_url!)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="crm-field-hint">
                POST JSON with <code>name</code> and <code>mobile</code>. A repeated delivery of the
                same number within 24 hours is ignored rather than duplicated, and unknown fields
                are dropped — so an integration cannot break by sending too much.
              </p>
              <div>
                <button className="btn btn-sm" onClick={rotate}>
                  Issue a new link
                </button>
                <span className="crm-field-hint" style={{ marginLeft: 8 }}>
                  The current one stops working immediately.
                </span>
              </div>
            </>
          ) : (
            <p className="crm-field-hint">Switch capture on to get a link.</p>
          )}
        </div>
      </section>

      <section className="card">
        <div className="crm-panel-head">
          <h2 className="crm-panel-title">Who a captured lead goes to</h2>
        </div>
        <div className="crm-grid-2" style={{ padding: 16 }}>
          <Field
            label="Assignment rule"
            hint="Applies to leads that arrive through the capture link. Leads added by hand keep whoever you pick on the form."
          >
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
            <Field label="Send every captured lead to">
              <OwnerSelect
                value={current.default_owner_id ?? ''}
                onChange={(value) => patch({ default_owner_id: value || null })}
              />
            </Field>
          )}

          {current.assignment_rule === 'round_robin' && (
            <Field
              label="Add somebody to the pool"
              hint={`Currently ${current.assignment_pool.length} in the rotation.`}
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
            </Field>
          )}
        </div>

        {current.assignment_rule === 'round_robin' && current.assignment_pool.length > 0 && (
          <div style={{ padding: '0 16px 16px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {current.assignment_pool.map((id) => (
              <span className="crm-pill" key={id}>
                <PoolMember id={id} />
                <button
                  className="link-btn"
                  onClick={() =>
                    patch({ assignment_pool: current.assignment_pool.filter((entry) => entry !== id) })
                  }
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
      </section>
    </>
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

/* -------------------------------------------------------------- documents --- */

function DocumentsPanel() {
  const settings = useQuery<Settings>('crm-settings', () => crm.settings())
  const [draft, setDraft] = useState<Partial<Settings>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const current = settings.data
  const value = <K extends keyof Settings>(key: K): Settings[K] | undefined =>
    (draft[key] ?? current?.[key]) as Settings[K] | undefined

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

  return (
    <section className="card">
      <div className="crm-panel-head">
        <div>
          <h2 className="crm-panel-title">Quotations, visits and tickets</h2>
          <p className="crm-field-hint" style={{ maxWidth: 640 }}>
            Prefixes are used from the next document onwards. Numbers already issued keep the prefix
            they were issued with, so history stays readable.
          </p>
        </div>
        {saved && <span className="crm-state crm-state-good crm-panel-link">Saved</span>}
      </div>

      {error && (
        <div style={{ padding: '0 16px 12px' }}>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="crm-grid-4" style={{ padding: 16 }}>
        <Field label="Quotation prefix" hint={`e.g. ${value('quotation_prefix')}-2026-0001`}>
          <input
            value={value('quotation_prefix') ?? ''}
            onChange={(event) => setDraft((d) => ({ ...d, quotation_prefix: event.target.value }))}
          />
        </Field>
        <Field label="Quotation validity (days)">
          <input
            type="number"
            min={1}
            max={365}
            value={value('quotation_validity_days') ?? 15}
            onChange={(event) =>
              setDraft((d) => ({ ...d, quotation_validity_days: Number(event.target.value) }))
            }
          />
        </Field>
        <Field label="Visit prefix" hint={`e.g. ${value('visit_prefix')}-0001`}>
          <input
            value={value('visit_prefix') ?? ''}
            onChange={(event) => setDraft((d) => ({ ...d, visit_prefix: event.target.value }))}
          />
        </Field>
        <Field label="Support ticket prefix" hint={`e.g. ${value('ticket_prefix')}-00001`}>
          <input
            value={value('ticket_prefix') ?? ''}
            onChange={(event) => setDraft((d) => ({ ...d, ticket_prefix: event.target.value }))}
          />
        </Field>
        <Field
          label="Renewal window (days)"
          hint="How early a customer starts showing as renewal due."
        >
          <input
            type="number"
            min={1}
            max={365}
            value={value('renewal_window_days') ?? 30}
            onChange={(event) =>
              setDraft((d) => ({ ...d, renewal_window_days: Number(event.target.value) }))
            }
          />
        </Field>
        <Field label="Default terms &amp; conditions" wide hint="Printed under the totals on a new quotation.">
          <textarea
            value={value('quotation_terms') ?? ''}
            onChange={(event) => setDraft((d) => ({ ...d, quotation_terms: event.target.value }))}
            rows={4}
          />
        </Field>
      </div>

      <div className="crm-foot">
        <button
          className="btn btn-primary"
          onClick={save}
          disabled={busy || Object.keys(draft).length === 0}
        >
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        {Object.keys(draft).length > 0 && (
          <button className="link-btn" onClick={() => setDraft({})}>
            Discard
          </button>
        )}
      </div>
    </section>
  )
}
