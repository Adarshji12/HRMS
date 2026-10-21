/* The master lists — every reference list the CRM's dropdowns are filled from,
 * declared once and rendered through one table.
 *
 * Ten-plus lists share a shape: a name, whether it is switched on, and one or
 * two fields of their own. The per-list differences are declared in `LISTS`
 * rather than written out per list, so adding a master is one entry here and
 * one on the server. `MASTER_GROUPS` says which card each list sits on in the
 * Master menu.
 *
 * Deleting a master that anything points at is refused by the server with a
 * sentence saying what is holding it. That refusal is rendered as-is: "42 leads
 * are in this stage" is an instruction, where "409 Conflict" is a puzzle.
 */

import { useState, type ReactNode } from 'react'
import '../../styles/crm.css'
import { useQuery } from '../../lib/useQuery'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconCheck, IconPlus } from '../../components/Icons'
import { crm, crmError } from '../crm/api'
import { Dialog, Field, MasterSelect, OwnerSelect } from '../crm/parts'

/* ---------------------------------------------------------- master shapes --- */

type FieldKind = 'text' | 'colour' | 'number' | 'check' | 'select' | 'parent' | 'date' | 'user' | 'states'

interface MasterField {
  key: string
  label: string
  kind: FieldKind
  options?: Array<{ value: string; label: string }>
  /** The master list a `parent` field picks from, and what its own parent is. */
  parentKind?: string
  parentOf?: string
  /** A `parent` field narrowed by another field's value — a city's district
   *  by the city's state. Changing that field clears this one. */
  dependsOn?: string
  hint?: string
  placeholder?: string
}

export interface ListDef {
  kind: string
  label: string
  description: string
  columns: Array<{ key: string; label: string }>
  fields: MasterField[]
  /** Filter the list by a parent chosen above it — states by country, and so on. */
  parent?: { kind: string; label: string; field: string }
}

const PRODUCT_CATEGORIES = [
  { value: 'product', label: 'Product' },
  { value: 'service', label: 'Service' },
  { value: 'implementation', label: 'Implementation' },
  { value: 'support_amc', label: 'Support / AMC' },
  { value: 'recurring', label: 'Recurring / subscription' },
]

const FORECAST_CATEGORIES = [
  { value: 'commit', label: 'Commit' },
  { value: 'best_case', label: 'Best case' },
  { value: 'pipeline', label: 'Pipeline' },
  { value: 'upside', label: 'Upside' },
]

/** Stored values a cell shows by their human label instead. */
const VALUE_LABELS: Record<string, Record<string, string>> = {
  category: Object.fromEntries(PRODUCT_CATEGORIES.map((o) => [o.value, o.label])),
  forecast_category: Object.fromEntries(FORECAST_CATEGORIES.map((o) => [o.value, o.label])),
  outcome: { lost: 'Lost', no_decision: 'No decision' },
}

export const LISTS: ListDef[] = [
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
    kind: 'districts',
    label: 'District Master',
    description: 'Districts, under their state. Cities can be filed under a district.',
    columns: [
      { key: 'name', label: 'District' },
      { key: 'state_name', label: 'State' },
    ],
    fields: [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'state_id', label: 'State', kind: 'parent', parentKind: 'states' },
    ],
    parent: { kind: 'states', label: 'State', field: 'state_id' },
  },
  {
    kind: 'cities',
    label: 'City Master',
    description: 'Cities, under the state they belong to. The district is optional and must be one of that state’s.',
    columns: [
      { key: 'name', label: 'City' },
      { key: 'district_name', label: 'District' },
      { key: 'state_name', label: 'State' },
    ],
    fields: [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'state_id', label: 'State', kind: 'parent', parentKind: 'states' },
      { key: 'district_id', label: 'District (optional)', kind: 'parent', parentKind: 'districts', dependsOn: 'state_id' },
    ],
    parent: { kind: 'states', label: 'State', field: 'state_id' },
  },
  {
    kind: 'industries',
    label: 'Industry / Vertical',
    description: 'What a lead or customer does, for segmenting the pipeline and setting vertical-wise targets.',
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
      { key: 'category', label: 'Category' },
      { key: 'oem', label: 'OEM' },
      { key: 'hsn_sac', label: 'HSN / SAC' },
      { key: 'rate', label: 'Rate' },
      { key: 'gst_percent', label: 'GST %' },
      { key: 'plan_count', label: 'Plans' },
    ],
    fields: [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'description', label: 'Description', kind: 'text' },
      {
        key: 'category',
        label: 'Revenue category',
        kind: 'select',
        hint: 'Which part of an opportunity\'s value this counts towards — the PRD amount split.',
        options: PRODUCT_CATEGORIES,
      },
      { key: 'oem', label: 'OEM / brand', kind: 'text', placeholder: 'Cisco, Microsoft…' },
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
  {
    kind: 'opportunity-stages',
    label: 'Opportunity Stages',
    description:
      'The deal pipeline a qualified lead converts into. Entering a stage sets its default win probability and forecast bucket; an opportunity left untouched longer than the stale limit is flagged. Closed stages are fixed at 100% (won) or 0%.',
    columns: [
      { key: 'name', label: 'Stage' },
      { key: 'behaviour', label: 'Behaviour' },
      { key: 'probability', label: 'Probability' },
      { key: 'forecast_category', label: 'Forecast' },
      { key: 'stale_after_days', label: 'Stale after' },
      { key: 'colour', label: 'Colour' },
    ],
    fields: [
      { key: 'name', label: 'Name', kind: 'text' },
      {
        key: 'behaviour',
        label: 'Behaviour',
        kind: 'select',
        options: [
          { value: 'open', label: 'Open — in the pipeline' },
          { value: 'won', label: 'Won' },
          { value: 'lost', label: 'Lost' },
          { value: 'no_decision', label: 'No decision — customer did not buy' },
        ],
      },
      { key: 'probability', label: 'Default probability (%)', kind: 'number' },
      {
        key: 'forecast_category',
        label: 'Default forecast category',
        kind: 'select',
        options: [{ value: '', label: '— none —' }, ...FORECAST_CATEGORIES],
      },
      { key: 'stale_after_days', label: 'Stale after (days)', kind: 'number', hint: '0 = never flagged.' },
      { key: 'colour', label: 'Colour', kind: 'colour' },
      { key: 'sort_order', label: 'Order', kind: 'number' },
    ],
  },
  {
    kind: 'lost-reasons',
    label: 'Lost Reasons',
    description:
      'The reasons a deal can be closed as Lost or No Decision. A reason that needs a competitor will not save without naming who won.',
    columns: [
      { key: 'name', label: 'Reason' },
      { key: 'outcome', label: 'Applies to' },
      { key: 'requires_competitor', label: 'Needs competitor' },
    ],
    fields: [
      { key: 'name', label: 'Name', kind: 'text' },
      {
        key: 'outcome',
        label: 'Applies to',
        kind: 'select',
        options: [
          { value: 'lost', label: 'Lost' },
          { value: 'no_decision', label: 'No decision' },
        ],
      },
      { key: 'requires_competitor', label: 'The competitor who won must be named', kind: 'check' },
      { key: 'sort_order', label: 'Order', kind: 'number' },
    ],
  },
  {
    kind: 'competitors',
    label: 'Competitors',
    description: 'Who you bid against or who is already installed at a customer, for win/loss analysis.',
    columns: [
      { key: 'name', label: 'Competitor' },
      { key: 'website', label: 'Website' },
    ],
    fields: [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'website', label: 'Website', kind: 'text', placeholder: 'https://' },
      { key: 'notes', label: 'Notes', kind: 'text', placeholder: 'Strengths, typical pricing…' },
    ],
  },
  {
    kind: 'territories',
    label: 'Territories',
    description:
      'Sales regions made of whole states. A state can be in one territory only, so a lead\'s state always answers which region it belongs to.',
    columns: [
      { key: 'name', label: 'Territory' },
      { key: 'code', label: 'Code' },
      { key: 'state_names', label: 'States' },
      { key: 'manager_name', label: 'Manager' },
    ],
    fields: [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'code', label: 'Code', kind: 'text', placeholder: 'N' },
      { key: 'manager_id', label: 'Territory manager', kind: 'user' },
      { key: 'sort_order', label: 'Order', kind: 'number' },
      { key: 'state_ids', label: 'States', kind: 'states' },
    ],
  },
  {
    kind: 'campaigns',
    label: 'Campaigns',
    description: 'Marketing pushes leads are attributed to. The source is the channel; the campaign is which spend on it.',
    columns: [
      { key: 'name', label: 'Campaign' },
      { key: 'source_name', label: 'Source' },
      { key: 'starts_on', label: 'Starts' },
      { key: 'ends_on', label: 'Ends' },
      { key: 'budget', label: 'Budget' },
    ],
    fields: [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'source_id', label: 'Lead source', kind: 'parent', parentKind: 'sources' },
      { key: 'starts_on', label: 'Starts on', kind: 'date' },
      { key: 'ends_on', label: 'Ends on', kind: 'date' },
      { key: 'budget', label: 'Budget (₹)', kind: 'number' },
    ],
  },
  {
    kind: 'contact-designations',
    label: 'Contact Designations',
    description: 'Job titles of the people you deal with at a customer — not your own staff\'s designations.',
    columns: [{ key: 'name', label: 'Designation' }],
    fields: [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'sort_order', label: 'Order', kind: 'number' },
    ],
  },
]

/* ------------------------------------------------------------ master table --- */

export function MasterTable({ list }: { list: ListDef }) {
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
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="crm-muted">—</span>
    const shown = value.slice(0, 4).join(', ')
    return value.length > 4 ? `${shown} +${value.length - 4}` : shown
  }
  if (key === 'probability' && typeof value === 'number') return `${value}%`
  if (key === 'stale_after_days' && typeof value === 'number') {
    return value ? `${value} days` : <span className="crm-muted">never</span>
  }
  if (typeof value === 'string' && VALUE_LABELS[key]?.[value]) return VALUE_LABELS[key][value]
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
          : field.kind === 'states'
            ? []
            : field.kind === 'colour'
              ? '#3882F6'
              : field.kind === 'select'
                ? (field.options?.[0]?.value ?? '')
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
      } else if (field.kind === 'states') {
        body[field.key] = Array.isArray(value) ? value : []
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
          const set = (next: unknown) =>
            setValues((current) => {
              const updated = { ...current, [field.key]: next }
              // A district chosen under the old state is not one of the new state's.
              for (const other of list.fields) {
                if (other.dependsOn === field.key && current[field.key] !== next) updated[other.key] = ''
              }
              return updated
            })
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
                  parentId={field.dependsOn ? String(values[field.dependsOn] ?? '') : undefined}
                  placeholder="—"
                />
              </Field>
            )
          }
          if (field.kind === 'date') {
            return (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <input type="date" value={String(value ?? '')} onChange={(event) => set(event.target.value)} />
              </Field>
            )
          }
          if (field.kind === 'user') {
            return (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <OwnerSelect value={String(value ?? '')} onChange={set} placeholder="— nobody —" />
              </Field>
            )
          }
          if (field.kind === 'states') {
            return (
              <Field key={field.key} label={field.label} hint={field.hint} wide>
                <StatePicker value={Array.isArray(value) ? (value as string[]) : []} onChange={set} />
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

/** Tick the states a territory is made of. States already in another
 *  territory are still offered: the server refuses the clash with a sentence
 *  naming the other territory, which says more than a greyed-out box would. */
function StatePicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const states = useQuery<Array<{ id: string; name: string; is_active: boolean }>>(
    'crm-master-states-all',
    () => crm.masters('states'),
  )
  if (states.loading) return <Loading />
  const chosen = new Set(value)
  const toggle = (id: string) =>
    onChange(chosen.has(id) ? value.filter((v) => v !== id) : [...value, id])
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
      {(states.data ?? [])
        .filter((state) => state.is_active || chosen.has(state.id))
        .map((state) => (
          <label key={state.id} className="crm-check">
            <input type="checkbox" checked={chosen.has(state.id)} onChange={() => toggle(state.id)} />
            {state.name}
          </label>
        ))}
    </div>
  )
}

/* ------------------------------------------------------------ the cards --- */

export interface MasterGroup {
  key: string
  title: string
  description: string
  /** Master lists on this card, opened at /masters/<kind>. */
  kinds: string[]
  /** Masters that have their own screens elsewhere, linked rather than copied. */
  links?: Array<{ label: string; to: string }>
  /** Set when the family has its own page and sidebar link instead of a card
      on the Master menu. Its lists open at `<path>/<kind>`. */
  path?: string
}

/** The Master menu's cards, in the order they are shown. */
export const MASTER_GROUPS: MasterGroup[] = [
  {
    key: 'geography',
    title: 'Geography',
    description: 'Where leads and customers are — and, through the state, which GST applies.',
    kinds: ['countries', 'states', 'districts', 'cities'],
  },
  {
    key: 'lead',
    title: 'Lead Master',
    description: 'How a lead is described from the moment it is captured.',
    kinds: ['statuses', 'sources', 'campaigns', 'industries'],
  },
  {
    key: 'erp',
    title: 'ERP Master',
    description: 'Items, warehouses, vendors and customer accounts for purchase, stock and billing.',
    kinds: [],
    links: [
      { label: 'Items', to: '/erp/masters?tab=items' },
      { label: 'Warehouses', to: '/erp/masters?tab=warehouses' },
      { label: 'Vendors', to: '/erp/masters?tab=vendors' },
      { label: 'Customer accounts', to: '/erp/masters?tab=customers' },
    ],
  },
  {
    key: 'sales',
    title: 'Sales Master',
    description: 'What the opportunity pipeline, forecast and win/loss analysis stand on.',
    kinds: ['opportunity-stages', 'lost-reasons', 'competitors', 'territories', 'contact-designations'],
    path: '/sales-master',
  },
  {
    key: 'product',
    title: 'Product Master',
    description: 'What you sell, at what rate and GST, and the plans it renews on.',
    kinds: ['products', 'plans'],
    path: '/product-master',
  },
  {
    key: 'service',
    title: 'Service Master',
    description: 'How support calls and field visits are classified.',
    kinds: ['dispositions', 'visit-types'],
  },
  {
    key: 'organisation',
    title: 'Organisation Master',
    description: 'Your own company’s structure — kept on its own screens.',
    kinds: [],
    links: [
      { label: 'Department', to: '/departments' },
      { label: 'Designation', to: '/designations' },
    ],
  },
]

/** A list's label without the trailing "Master", for use on a card. */
export function shortLabel(list: ListDef): string {
  return list.label.replace(/\s+Master$/, '')
}
