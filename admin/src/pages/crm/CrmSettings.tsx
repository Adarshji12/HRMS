/* CRM Settings — the masters every other CRM screen fills its dropdowns from,
 * plus how a captured lead is assigned and how documents are numbered.
 *
 * Ten master lists behind one table component, because they are the same shape:
 * a name, whether it is switched on, and one or two fields of their own. The
 * per-list differences are declared in `LISTS` rather than written out ten
 * times, so adding "Campaign master" tomorrow is one entry here and one entry
 * on the server, not two hundred lines of copied JSX.
 *
 * Deleting a master that anything points at is refused by the server with a
 * sentence saying what is holding it. That refusal is rendered as-is: "42 leads
 * are in this stage" is an instruction, where "409 Conflict" is a puzzle.
 */

import { useState, type ReactNode } from 'react'
import '../../styles/crm.css'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { canAdminister, useAuth } from '../../lib/auth'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import {
  IconCheck,
  IconGear,
  IconGlobe,
  IconPlus,
  IconSheet,
  IconUsers,
} from '../../components/Icons'
import { crm, crmError, type CrmSettings as Settings } from './api'
import { CrmPage, Dialog, Field, MasterSelect, OwnerSelect } from './parts'

/* ---------------------------------------------------------- master shapes --- */

type FieldKind = 'text' | 'colour' | 'number' | 'check' | 'select' | 'parent'

interface MasterField {
  key: string
  label: string
  kind: FieldKind
  options?: Array<{ value: string; label: string }>
  /** The master list a `parent` field picks from, and what its own parent is. */
  parentKind?: string
  parentOf?: string
  hint?: string
  placeholder?: string
}

interface ListDef {
  kind: string
  label: string
  description: string
  columns: Array<{ key: string; label: string }>
  fields: MasterField[]
  /** Filter the list by a parent chosen above it — states by country, and so on. */
  parent?: { kind: string; label: string; field: string }
}

const LISTS: ListDef[] = [
  {
    kind: 'statuses',
    label: 'Lead Statuses',
    description:
      'Stages a lead moves through. New leads start at the default status; a Won or Lost stage takes the lead out of the pipeline and cancels what was owed on it.',
    columns: [
      { key: 'name', label: 'Status' },
      { key: 'behaviour', label: 'Behaviour' },
      { key: 'colour', label: 'Colour' },
      { key: 'lead_count', label: 'Leads' },
    ],
    fields: [
      { key: 'name', label: 'Name', kind: 'text' },
      {
        key: 'behaviour',
        label: 'Behaviour',
        kind: 'select',
        hint: 'What this stage means to the funnel, whatever you call it.',
        options: [
          { value: 'default', label: 'Default — new leads land here' },
          { value: 'in_progress', label: 'In progress' },
          { value: 'won', label: 'Won — out of the pipeline' },
          { value: 'lost', label: 'Lost — out of the pipeline' },
        ],
      },
      { key: 'colour', label: 'Colour', kind: 'colour' },
      { key: 'sort_order', label: 'Order', kind: 'number' },
    ],
  },
  {
    kind: 'sources',
    label: 'Lead Sources',
    description: 'Where a lead came from. One source can be marked as the one captured leads land on.',
    columns: [
      { key: 'name', label: 'Source' },
      { key: 'is_intake_default', label: 'Capture default' },
    ],
    fields: [
      { key: 'name', label: 'Name', kind: 'text' },
      {
        key: 'is_intake_default',
        label: 'Captured leads land on this source',
        kind: 'check',
      },
    ],
  },
  {
    kind: 'countries',
    label: 'Country Master',
    description: 'Countries you sell into. States hang off these.',
    columns: [
      { key: 'name', label: 'Country' },
      { key: 'iso2', label: 'ISO' },
      { key: 'dial_code', label: 'Dial code' },
    ],
    fields: [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'iso2', label: 'ISO code', kind: 'text', placeholder: 'IN' },
      { key: 'dial_code', label: 'Dial code', kind: 'text', placeholder: '+91' },
    ],
  },
  {
    kind: 'states',
    label: 'State Master',
    description:
      'The GST code on a state is what decides CGST + SGST against IGST on a quotation, so it is set here rather than typed per document.',
    columns: [
      { key: 'name', label: 'State' },
      { key: 'country_name', label: 'Country' },
      { key: 'gst_code', label: 'GST code' },
    ],
    fields: [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'country_id', label: 'Country', kind: 'parent', parentKind: 'countries' },
      { key: 'gst_code', label: 'GST state code', kind: 'text', placeholder: '27' },
    ],
    parent: { kind: 'countries', label: 'Country', field: 'country_id' },
  },
  {
    kind: 'cities',
    label: 'City Master',
    description: 'Cities, under the state they belong to.',
    columns: [
      { key: 'name', label: 'City' },
      { key: 'state_name', label: 'State' },
    ],
    fields: [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'state_id', label: 'State', kind: 'parent', parentKind: 'states' },
    ],
    parent: { kind: 'states', label: 'State', field: 'state_id' },
  },
  {
    kind: 'industries',
    label: 'Industry Type',
    description: 'What a lead or customer does, for segmenting the pipeline.',
    columns: [{ key: 'name', label: 'Industry' }],
    fields: [{ key: 'name', label: 'Name', kind: 'text' }],
  },
  {
    kind: 'products',
    label: 'Product / Service',
    description:
      'What you sell. The rate and GST here are the starting point for a quotation line — the line keeps whatever it was saved with afterwards.',
    columns: [
      { key: 'name', label: 'Product / Service' },
      { key: 'hsn_sac', label: 'HSN / SAC' },
      { key: 'rate', label: 'Rate' },
      { key: 'gst_percent', label: 'GST %' },
      { key: 'plan_count', label: 'Plans' },
    ],
    fields: [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'description', label: 'Description', kind: 'text' },
      { key: 'hsn_sac', label: 'HSN / SAC', kind: 'text' },
      { key: 'unit', label: 'Unit', kind: 'text', placeholder: 'licence, hour, unit' },
      { key: 'rate', label: 'Rate (₹)', kind: 'number' },
      { key: 'gst_percent', label: 'GST %', kind: 'number' },
    ],
  },
  {
    kind: 'plans',
    label: 'Plan Master',
    description:
      'A priced term of a product. The duration is what a renewal date is worked out from; leave it blank for a one-off sale with no renewal.',
    columns: [
      { key: 'name', label: 'Plan' },
      { key: 'product_name', label: 'Product' },
      { key: 'duration_days', label: 'Days' },
      { key: 'price', label: 'Price' },
    ],
    fields: [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'product_id', label: 'Product', kind: 'parent', parentKind: 'products' },
      { key: 'duration_days', label: 'Duration in days', kind: 'number', hint: 'Blank = perpetual.' },
      { key: 'price', label: 'Price (₹)', kind: 'number' },
      { key: 'gst_percent', label: 'GST % (optional)', kind: 'number' },
    ],
    parent: { kind: 'products', label: 'Product', field: 'product_id' },
  },
  {
    kind: 'dispositions',
    label: 'Call Disposition',
    description:
      'What a logged call was about. A disposition marked as closing sets the call to Closed by default.',
    columns: [
      { key: 'name', label: 'Disposition' },
      { key: 'closes_interaction', label: 'Closes the call' },
    ],
    fields: [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'closes_interaction', label: 'Choosing this closes the interaction', kind: 'check' },
      { key: 'sort_order', label: 'Order', kind: 'number' },
    ],
  },
  {
    kind: 'visit-types',
    label: 'Visit Master',
    description:
      'Kinds of field call. A type that requires an arrival code forces the employee to prove they were there before the visit can start.',
    columns: [
      { key: 'name', label: 'Visit type' },
      { key: 'requires_otp', label: 'Arrival code' },
      { key: 'colour', label: 'Colour' },
    ],
    fields: [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'colour', label: 'Colour', kind: 'colour' },
      { key: 'requires_otp', label: 'Needs an arrival code', kind: 'check' },
      { key: 'sort_order', label: 'Order', kind: 'number' },
    ],
  },
]

const TABS = [
  { key: 'masters', label: 'Leads Master', icon: IconUsers },
  { key: 'intake', label: 'Lead Intake', icon: IconGlobe },
  { key: 'documents', label: 'Quotation & numbering', icon: IconSheet },
] as const

type TabKey = (typeof TABS)[number]['key']

export default function CrmSettings() {
  const { user } = useAuth()
  const [tab, setTab] = useState<TabKey>('masters')
  const [listKind, setListKind] = useState(LISTS[0].kind)

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

  const list = LISTS.find((entry) => entry.kind === listKind)!

  return (
    <CrmPage title="CRM Settings" subtitle="Lead capture, assignment rules and the CRM masters">
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

      {tab === 'masters' && (
        <>
          <div className="crm-subtabs">
            {LISTS.map((entry) => (
              <button
                key={entry.kind}
                className={`crm-tab${listKind === entry.kind ? ' crm-tab-on' : ''}`}
                onClick={() => setListKind(entry.kind)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <MasterTable key={list.kind} list={list} />
        </>
      )}

      {tab === 'intake' && <IntakePanel />}
      {tab === 'documents' && <DocumentsPanel />}
    </CrmPage>
  )
}

/* ------------------------------------------------------------ master table --- */

function MasterTable({ list }: { list: ListDef }) {
  const [parentId, setParentId] = useState('')
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')

  const rows = useQuery<Array<Record<string, unknown>>>(
    `crm-master-table-${list.kind}-${parentId}`,
    () => crm.masters<Record<string, unknown>>(list.kind, parentId || undefined),
  )

  const data = (rows.data ?? []).filter((row) =>
    q ? String(row.name ?? '').toLowerCase().includes(q.toLowerCase()) : true,
  )

  async function remove(row: Record<string, unknown>) {
    setError(null)
    try {
      await crm.deleteMaster(list.kind, String(row.id))
      rows.reload()
    } catch (err) {
      setError(crmError(err, 'That entry could not be deleted'))
    }
  }

  async function toggleActive(row: Record<string, unknown>) {
    setError(null)
    try {
      await crm.updateMaster(list.kind, String(row.id), { ...row, is_active: !row.is_active })
      rows.reload()
    } catch (err) {
      setError(crmError(err, 'That entry could not be changed'))
    }
  }

  return (
    <section className="card">
      <div className="crm-panel-head">
        <div>
          <h2 className="crm-panel-title">{list.label}</h2>
          <p className="crm-field-hint" style={{ maxWidth: 640 }}>
            {list.description}
          </p>
        </div>
        <div className="crm-panel-link" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {list.parent && (
            <MasterSelect
              kind={list.parent.kind}
              value={parentId}
              onChange={setParentId}
              placeholder={`All ${list.parent.label.toLowerCase()}s`}
            />
          )}
          <input
            type="search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Search…"
            aria-label={`Search ${list.label}`}
          />
          <span className="crm-sub">{data.length}</span>
          <button className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>
            <IconPlus size={14} /> Add
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: '0 16px 12px' }}>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {rows.loading ? (
        <Loading />
      ) : data.length === 0 ? (
        <EmptyState
          title={`Nothing on the ${list.label.toLowerCase()} list`}
          body="Add the entries your team should be able to choose from."
          action={
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              Add the first one
            </button>
          }
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {list.columns.map((column) => (
                  <th key={column.key}>{column.label}</th>
                ))}
                <th>Active</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={String(row.id)} style={{ opacity: row.is_active === false ? 0.55 : 1 }}>
                  {list.columns.map((column) => (
                    <td key={column.key}>{renderCell(column.key, row)}</td>
                  ))}
                  <td>
                    <label className="crm-check">
                      <input
                        type="checkbox"
                        checked={row.is_active !== false}
                        onChange={() => toggleActive(row)}
                      />
                      {row.is_active !== false ? 'On' : 'Off'}
                    </label>
                  </td>
                  <td>
                    <div className="crm-row-actions">
                      <button className="link-btn" onClick={() => setEditing(row)}>
                        Edit
                      </button>
                      <button className="link-btn" onClick={() => remove(row)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(adding || editing) && (
        <MasterForm
          list={list}
          row={editing}
          defaultParentId={parentId}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
          onSaved={() => {
            setAdding(false)
            setEditing(null)
            rows.reload()
          }}
        />
      )}
    </section>
  )
}

function renderCell(key: string, row: Record<string, unknown>): ReactNode {
  const value = row[key]
  if (key === 'colour' && typeof value === 'string') {
    return (
      <span className="crm-pill">
        <span className="crm-pill-dot" style={{ background: value }} />
        {value}
      </span>
    )
  }
  if (key === 'behaviour' && typeof value === 'string') {
    return <span className="crm-pill">{value.replace('_', ' ')}</span>
  }
  if (typeof value === 'boolean') {
    return value ? <IconCheck size={15} /> : <span className="crm-muted">—</span>
  }
  if (value === null || value === undefined || value === '') return <span className="crm-muted">—</span>
  if (key === 'name') return <span className="crm-strong">{String(value)}</span>
  return String(value)
}

function MasterForm({
  list,
  row,
  defaultParentId,
  onClose,
  onSaved,
}: {
  list: ListDef
  row: Record<string, unknown> | null
  defaultParentId: string
  onClose: () => void
  onSaved: () => void
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = { is_active: row?.is_active ?? true }
    for (const field of list.fields) {
      initial[field.key] =
        row?.[field.key] ??
        (field.kind === 'check'
          ? false
          : field.kind === 'colour'
            ? '#3882F6'
            : field.kind === 'parent' && list.parent?.field === field.key
              ? defaultParentId
              : '')
    }
    if (list.kind === 'statuses' && !row) initial.behaviour = 'in_progress'
    return initial
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    const body: Record<string, unknown> = { is_active: values.is_active !== false }
    for (const field of list.fields) {
      const value = values[field.key]
      if (field.kind === 'number') {
        body[field.key] = value === '' || value === null ? null : Number(value)
      } else if (field.kind === 'check') {
        body[field.key] = Boolean(value)
      } else {
        body[field.key] = value === '' ? null : value
      }
    }
    // A required name is required; sending null would fail validation with a
    // message about the schema rather than about the form.
    if (!String(body.name ?? '').trim()) {
      setError('Give it a name.')
      setBusy(false)
      return
    }
    try {
      if (row) await crm.updateMaster(list.kind, String(row.id), body)
      else await crm.createMaster(list.kind, body)
      onSaved()
    } catch (err) {
      setError(crmError(err, 'That entry could not be saved'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={row ? `Edit ${String(row.name ?? '')}` : `Add to ${list.label}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="crm-form">
        {error && (
          <div className="crm-form-wide">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}
        {list.fields.map((field) => {
          const value = values[field.key]
          const set = (next: unknown) => setValues((current) => ({ ...current, [field.key]: next }))
          if (field.kind === 'check') {
            return (
              <div className="crm-field crm-form-wide" key={field.key}>
                <label className="crm-check">
                  <input
                    type="checkbox"
                    checked={Boolean(value)}
                    onChange={(event) => set(event.target.checked)}
                  />
                  {field.label}
                </label>
                {field.hint && <span className="crm-field-hint">{field.hint}</span>}
              </div>
            )
          }
          if (field.kind === 'select') {
            return (
              <Field key={field.key} label={field.label} hint={field.hint} wide>
                <select value={String(value ?? '')} onChange={(event) => set(event.target.value)}>
                  {(field.options ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
            )
          }
          if (field.kind === 'parent') {
            return (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <MasterSelect
                  kind={field.parentKind!}
                  value={String(value ?? '')}
                  onChange={set}
                  placeholder="—"
                />
              </Field>
            )
          }
          if (field.kind === 'colour') {
            return (
              <Field key={field.key} label={field.label}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="crm-swatch"
                    type="color"
                    value={String(value ?? '#3882F6')}
                    onChange={(event) => set(event.target.value)}
                    aria-label={field.label}
                  />
                  <input value={String(value ?? '')} onChange={(event) => set(event.target.value)} />
                </div>
              </Field>
            )
          }
          return (
            <Field key={field.key} label={field.label} hint={field.hint}>
              <input
                value={String(value ?? '')}
                onChange={(event) => set(event.target.value)}
                placeholder={field.placeholder}
                inputMode={field.kind === 'number' ? 'decimal' : undefined}
              />
            </Field>
          )
        })}
      </div>
    </Dialog>
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
