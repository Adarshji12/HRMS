/* My Follow-ups — everything owed to somebody, and when.
 *
 * This is the page a salesperson lives in, so it opens on the shortest useful
 * answer: what is pending, soonest first, overdue at the top and coloured.
 * Nothing here is a second copy of a lead — completing a follow-up can move the
 * lead's stage and book the next call in the same action, because that is one
 * act to the person doing it: they have just put the phone down.
 *
 * The cards count the whole pending pile, not the filtered view, so "how much
 * is overdue" does not change because somebody typed in the search box. Each
 * card is also the filter for its window.
 */

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import '../../styles/crm.css'
import '../../styles/visits.css'
import '../../styles/followups.css'
import '../../styles/leads.css'
import '../../styles/hrdash.css'
import { useQuery } from '../../lib/useQuery'
import { relativeTime } from '../../lib/format'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconAlert, IconBuilding, IconCalendar, IconCheck, IconClock, IconClose, IconEdit, IconPlus, IconSearch, IconSheet, IconSliders, IconTrash, IconUpload, IconUser } from '../../components/Icons'
import { ExportButton } from '../../components/ExportButton'
import {
  crm,
  crmError,
  isoToLocalInput,
  localToISO,
  qs,
  type Customer,
  type FollowUp,
  type Lead,
} from './api'
import {
  CrmPage,
  Dialog,
  CustomerPicker,
  Field,
  LeadPicker,
  MasterSelect,
  OwnerSelect,
  StateText,
  WhatsAppButton,
} from './parts'
import { splitCsvLine } from './MyLeads'
import { ColumnSettings, FieldSettings, useColumns, useFieldModes, type ColumnDef, type FieldDef, type FieldSection } from '../../components/ViewSettings'

type Window = '' | 'overdue' | 'today' | 'week' | 'upcoming'
type Status = 'all' | 'pending' | 'done' | 'cancelled'
type Kind = '' | 'lead' | 'customer'

const STATUSES: Array<{ key: Status; label: string }> = [
  { key: 'all', label: 'All statuses' },
  { key: 'pending', label: 'Pending' },
  { key: 'done', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
]

const parseISO = (iso: string) => new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`)

const initials = (name: string | null | undefined) =>
  (name ?? '?').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?'

/* The same windows the server filters by (services/crm.py), counted here from
   one unfiltered pending list. */
function countWindows(rows: FollowUp[]) {
  const now = new Date()
  const weekEnd = new Date(now)
  weekEnd.setDate(weekEnd.getDate() + 7)
  weekEnd.setHours(23, 59, 59, 999)
  let overdue = 0, today = 0, week = 0, upcoming = 0
  for (const row of rows) {
    const due = parseISO(row.due_at)
    if (row.is_overdue || due < now) overdue++
    else upcoming++
    if (due.toDateString() === now.toDateString()) today++
    if (due <= weekEnd) week++
  }
  return { all: rows.length, overdue, today, week, upcoming }
}

/** What the follow-ups table can show. A person picks and orders these from
 *  Settings; the first five are what it shows until they do. */
type FollowUpColumn = ColumnDef & { td: (row: FollowUp) => ReactNode; className?: string }
const dash = <span className="crm-muted">—</span>
const FOLLOW_UP_COLUMNS: FollowUpColumn[] = [
  { key: 'due', label: 'Due', locked: true, className: 'crm-nowrap', td: (r) => (
    <Due iso={r.due_at} overdue={r.status === 'pending' && r.is_overdue} />
  ) },
  { key: 'contact', label: 'Contact', td: (r) => (
    <div className="vs-who">
      <span className="vs-avatar" aria-hidden>{initials(r.subject_name)}</span>
      <span className="vs-who-text">
        <span className="crm-strong">{r.subject_name ?? '—'}</span>
        <span className="crm-sub">
          <span className={`fu-kind is-${r.subject_kind === 'customer' ? 'customer' : 'lead'}`}>
            {r.subject_kind === 'customer' ? 'Customer' : 'Lead'}
          </span>
          {r.subject_mobile ? ` ${r.subject_mobile}` : ''}
        </span>
      </span>
    </div>
  ) },
  { key: 'purpose', label: 'Purpose', className: 'fu-purpose', td: (r) => (
    <>
      {r.purpose ?? dash}
      {r.notes && <div className="crm-sub">{r.notes}</div>}
      {r.outcome && <div className="crm-sub">Outcome: {r.outcome}</div>}
    </>
  ) },
  { key: 'owner', label: 'Owner', td: (r) => r.owner_name ?? <span className="crm-muted">Unassigned</span> },
  { key: 'status', label: 'Status', td: (r) => <StateText value={r.status} /> },
  { key: 'kind', label: 'Lead / Customer', initial: false, td: (r) => (r.subject_kind === 'customer' ? 'Customer' : 'Lead') },
  { key: 'mobile', label: 'Mobile', initial: false, className: 'crm-nowrap', td: (r) => r.subject_mobile ?? dash },
  { key: 'created', label: 'Booked on', initial: false, className: 'crm-nowrap', td: (r) => new Date(r.created_at).toLocaleDateString('en-IN') },
  { key: 'completed', label: 'Completed on', initial: false, className: 'crm-nowrap', td: (r) => (r.completed_at ? new Date(r.completed_at).toLocaleDateString('en-IN') : dash) },
]

/** What the Add follow-up form can show, make mandatory or hide. Who it is for
 *  and when it is due are always there. */
const FOLLOW_UP_SECTIONS: FieldSection[] = [{ id: 'details', label: 'Follow-up details' }]
const FOLLOW_UP_FIELDS: FieldDef[] = [
  { key: 'due', label: 'Due', section: 'details', fixed: true },
  { key: 'owner', label: 'Owner', section: 'details', initial: 'mandatory' },
  { key: 'purpose', label: 'Purpose', section: 'details', initial: 'mandatory' },
  { key: 'notes', label: 'Notes', section: 'details' },
]

export default function MyFollowUps() {
  const navigate = useNavigate()
  const columns = useColumns('follow-ups', FOLLOW_UP_COLUMNS)
  const [params] = useSearchParams()
  const [window, setWindow] = useState<Window>((params.get('window') ?? '') as Window)
  const [status, setStatus] = useState<Status>('pending')
  const [ownerId, setOwnerId] = useState('')
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<Kind>('')
  // Dates as the viewer reads them (yyyy-mm-dd); sent as the edges of those days.
  const [dueFrom, setDueFrom] = useState('')
  const [dueTo, setDueTo] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(false)
  const [completing, setCompleting] = useState<FollowUp | null>(null)
  const [editing, setEditing] = useState<FollowUp | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)

  // One set of filters for the table and the export, so the file is the screen.
  const query = {
    status,
    window: window || undefined,
    owner_id: ownerId || undefined,
    q: q.trim() || undefined,
    kind: kind || undefined,
    due_from: dueFrom ? new Date(`${dueFrom}T00:00:00`).toISOString() : undefined,
    due_to: dueTo ? new Date(`${dueTo}T23:59:59.999`).toISOString() : undefined,
  }
  const rows = useQuery<FollowUp[]>(
    `crm-followups-${status}-${window}-${ownerId}-${q}-${kind}-${dueFrom}-${dueTo}`,
    () => crm.followUps(query),
  )
  const pending = useQuery<FollowUp[]>(`crm-followups-counts-${ownerId}`, () =>
    crm.followUps({ status: 'pending', owner_id: ownerId || undefined }),
  )

  const list = rows.data ?? []
  const c = countWindows(pending.data ?? [])
  const extraFilters = [status !== 'pending' ? status : '', ownerId, kind, dueFrom, dueTo].filter(Boolean).length
  const filtered = Boolean(q || window || ownerId || extraFilters)

  /* The box closes on a click outside it or on Escape, as on My Leads. */
  useEffect(() => {
    if (!showFilters) return
    const onDown = (e: MouseEvent) => {
      if (!filterRef.current?.contains(e.target as Node)) setShowFilters(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowFilters(false) }
    // On `document`: this component's `window` is the due-window filter.
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [showFilters])

  function clearFilters() {
    setQ('')
    setWindow('')
    setOwnerId('')
    setKind('')
    setDueFrom('')
    setDueTo('')
  }

  function reloadAll() {
    rows.reload()
    pending.reload()
  }

  async function cancel(row: FollowUp) {
    setRowError(null)
    try {
      await crm.cancelFollowUp(row.id)
      reloadAll()
    } catch (err) {
      setRowError(crmError(err, 'That follow-up could not be cancelled'))
    }
  }

  async function remove(row: FollowUp) {
    if (!globalThis.confirm("Delete this follow-up? It will not stay in the history.")) return
    setRowError(null)
    try {
      await crm.deleteFollowUp(row.id)
      reloadAll()
    } catch (err) {
      setRowError(crmError(err, 'That follow-up could not be deleted'))
    }
  }

  if (rows.error && !rows.data) {
    return (
      <CrmPage title="My Follow-ups">
        <ErrorNote>{crmError(rows.cause, 'Could not load your follow-ups')}</ErrorNote>
      </CrmPage>
    )
  }

  const cards: Array<{ key: Window; label: string; value: number; tone: string; hint: string; icon: ReactNode }> = [
    { key: '', label: 'All pending', value: c.all, tone: 'brand', hint: 'Everything still owed', icon: <IconSheet size={16} /> },
    { key: 'overdue', label: 'Overdue', value: c.overdue, tone: c.overdue ? 'bad' : 'idle', hint: c.overdue ? 'Call these first' : 'Nothing late', icon: <IconAlert size={16} /> },
    { key: 'today', label: 'Due today', value: c.today, tone: 'warn', hint: 'Before the day ends', icon: <IconClock size={16} /> },
    { key: 'week', label: 'Next 7 days', value: c.week, tone: 'idle', hint: 'Including anything late', icon: <IconCalendar size={16} /> },
    { key: 'upcoming', label: 'Upcoming', value: c.upcoming, tone: 'good', hint: 'Not yet due', icon: <IconCheck size={16} /> },
  ]

  return (
    <CrmPage>
      <div className="hrd-kpis crm-kpis" role="group" aria-label="Follow-up summary">
        {cards.map((card) => {
          const on = status === 'pending' && window === card.key
          return (
            <button
              key={card.key || 'all'}
              type="button"
              className={`hrd-kpi cu-kpi tone-${card.tone}${on ? ' is-on' : ''}`}
              aria-pressed={on}
              onClick={() => {
                setStatus('pending')
                setWindow(card.key)
              }}
            >
              <span className="hrd-kpi-top">
                <span className="hrd-kpi-label">{card.label}</span>
                <span className="hrd-kpi-icon" aria-hidden>{card.icon}</span>
              </span>
              <span className="hrd-kpi-value">{pending.data ? card.value : '–'}</span>
              <span className="hrd-kpi-hint">{card.hint}</span>
            </button>
          )
        })}
      </div>

      {rowError && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{rowError}</ErrorNote>
        </div>
      )}

      <section className="card vs-card fu-card">
        {/* One toolbar: search, status, the Filters box, export, import, add. */}
        <div className="fu-bar">
          <div className="crm-search fu-bar-search">
            <IconSearch size={15} />
            <input
              type="search"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="Search lead, mobile or purpose…"
              aria-label="Search follow-ups"
            />
          </div>
          <div className="ml-filter" ref={filterRef}>
            <button
              type="button"
              className={`btn fu-filter-btn${showFilters || extraFilters ? ' is-on' : ''}`}
              onClick={() => setShowFilters((open) => !open)}
              aria-expanded={showFilters}
              aria-haspopup="dialog"
            >
              <IconSliders size={15} /> Filters
              {extraFilters > 0 && <span className="ml-filter-count">{extraFilters}</span>}
            </button>
            {showFilters && (
              /* Each change applies at once, so there is no Apply to forget. */
              <div className="ml-pop fu-pop" role="dialog" aria-label="Filter follow-ups">
                <label className="ml-pop-field ml-pop-wide">
                  <span>Contact</span>
                  <select value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
                    <option value="">Leads and customers</option>
                    <option value="lead">Leads only</option>
                    <option value="customer">Customers only</option>
                  </select>
                </label>
                <label className="ml-pop-field">
                  <span>Status</span>
                  <select
                    value={status}
                    onChange={(event) => {
                      const next = event.target.value as Status
                      setStatus(next)
                      if (next !== 'pending') setWindow('')
                    }}
                  >
                    {STATUSES.map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="ml-pop-field">
                  <span>Owner</span>
                  <OwnerSelect value={ownerId} onChange={setOwnerId} placeholder="Any owner" />
                </label>
                <div className="ml-pop-dates">
                  <label className="ml-pop-field">
                    <span>Due from</span>
                    <input type="date" value={dueFrom} max={dueTo || undefined}
                           onChange={(event) => setDueFrom(event.target.value)} />
                  </label>
                  <label className="ml-pop-field">
                    <span>Due to</span>
                    <input type="date" value={dueTo} min={dueFrom || undefined}
                           onChange={(event) => setDueTo(event.target.value)} />
                  </label>
                </div>
                <button
                  type="button"
                  className="ml-pop-reset"
                  onClick={() => { setStatus('pending'); setOwnerId(''); setKind(''); setDueFrom(''); setDueTo('') }}
                  disabled={extraFilters === 0}
                >
                  Reset filters
                </button>
              </div>
            )}
          </div>
          <ColumnSettings defs={FOLLOW_UP_COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden}
                          onSave={columns.save} onReset={columns.reset} />
          <ExportButton
            iconOnly
            className="btn fu-icon-btn"
            label="Export follow-ups"
            href={`/crm/follow-ups/export${qs(query)}`}
            filename={`follow-ups-${new Date().toISOString().slice(0, 10)}.csv`}
            disabled={list.length === 0}
          />
          <button
            type="button"
            className="btn fu-icon-btn"
            onClick={() => setImporting(true)}
            title="Import follow-ups"
            aria-label="Import follow-ups"
          >
            <IconUpload size={17} />
          </button>
          <button type="button" className="btn btn-primary fu-add" onClick={() => setAdding(true)}>
            <IconPlus size={15} /> Add Follow-up
          </button>
        </div>

        {(window || filtered) && (
          <div className="fu-chips">
            {window && (
              <span className="fu-active">
                {cards.find((card) => card.key === window)?.label}
                <button aria-label="Remove window filter" onClick={() => setWindow('')}>×</button>
              </span>
            )}
            {filtered && (
              <button className="filter-reset" onClick={clearFilters}>
                Clear all
              </button>
            )}
          </div>
        )}

        <div style={{ opacity: rows.refetching ? 0.6 : 1 }}>
          {list.length === 0 ? (
            rows.loading ? (
              <Loading />
            ) : (
              <EmptyState
                icon={filtered ? <IconSearch size={22} /> : <IconCheck size={22} />}
                title={
                  filtered ? 'No follow-ups match'
                    : status === 'pending' ? 'Nothing is owed right now' : 'Nothing here'
                }
                body={
                  filtered
                    ? 'Nothing fits these filters. Clear them to see everything.'
                    : status === 'pending'
                      ? 'Every call you promised has been made. Book the next one from a lead or from the support desk and it will appear here.'
                      : 'Switch to Pending to see what is still owed.'
                }
              />
            )
          ) : (
            <>
              <div className="table-wrap">
                <table className="vs-table">
                  <thead>
                    <tr>
                      {(columns.visible as FollowUpColumn[]).map((col) => (
                        <th key={col.key}>{col.label}</th>
                      ))}
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((row) => (
                      <tr key={row.id}
                          className={`${row.status === 'pending' && row.is_overdue ? 'fu-row-late' : ''}${row.lead_id ? ' fu-row-link' : ''}`.trim() || undefined}
                          onClick={row.lead_id ? () => navigate(`/crm/leads/${row.lead_id}`) : undefined}>
                        {(columns.visible as FollowUpColumn[]).map((col) => (
                          <td key={col.key} className={col.className}>{col.td(row)}</td>
                        ))}
                        <td onClick={(e) => e.stopPropagation()}>
                          <div className="crm-row-actions">
                            {row.status === 'pending' && (
                              <button
                                className="btn btn-sm btn-primary"
                                onClick={() => setCompleting(row)}
                              >
                                Complete
                              </button>
                            )}
                            <WhatsAppButton mobile={row.subject_mobile} />
                            {row.status === 'pending' && (
                              <>
                                <button className="crm-icon-btn" onClick={() => setEditing(row)} title="Edit"
                                        aria-label={`Edit follow-up for ${row.subject_name ?? 'contact'}`}>
                                  <IconEdit size={14} />
                                </button>
                                <button className="crm-icon-btn" onClick={() => cancel(row)} title="Cancel"
                                        aria-label={`Cancel follow-up for ${row.subject_name ?? 'contact'}`}>
                                  <IconClose size={14} />
                                </button>
                              </>
                            )}
                            <button
                              className="crm-icon-btn crm-icon-danger"
                              onClick={() => remove(row)}
                              title="Delete"
                              aria-label={`Delete ${row.subject_name ?? 'follow-up'}`}
                            >
                              <IconTrash size={15} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="crm-foot">
                <span>
                  Showing {list.length} follow-up{list.length === 1 ? '' : 's'}
                </span>
              </div>
            </>
          )}
        </div>
      </section>

      {importing && (
        <ImportFollowUpsDialog
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false)
            reloadAll()
          }}
        />
      )}

      {adding && (
        <AddFollowUpDialog
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false)
            reloadAll()
          }}
        />
      )}

      {editing && (
        <AddFollowUpDialog
          existing={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null)
            reloadAll()
          }}
        />
      )}

      {completing && (
        <CompleteDialog
          followUp={completing}
          onClose={() => setCompleting(null)}
          onDone={() => {
            setCompleting(null)
            reloadAll()
          }}
        />
      )}
    </CrmPage>
  )
}

/** A date chip — red when late, amber when it lands today — over how far off it is. */
function Due({ iso, overdue }: { iso: string; overdue: boolean }) {
  const d = parseISO(iso)
  const isToday = d.toDateString() === new Date().toDateString()
  const tone = overdue ? 'is-late' : isToday ? 'is-today' : ''
  return (
    <div className="fu-due">
      <span className={`fu-date ${tone}`}>
        <strong>{d.toLocaleDateString(undefined, { day: '2-digit' })}</strong>
        <span>{d.toLocaleDateString(undefined, { month: 'short' })}</span>
      </span>
      <span className="fu-due-text">
        <span>{d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
        <span className={`crm-sub ${overdue ? 'fu-late-text' : ''}`}>{relativeTime(iso)}</span>
      </span>
    </div>
  )
}

/** Book a follow-up against a lead or a customer from this page, without
 *  opening the record first. */
function AddFollowUpDialog({ onClose, onDone, existing }: { onClose: () => void; onDone: () => void; existing?: FollowUp }) {
  const fields = useFieldModes('follow-up-form', FOLLOW_UP_FIELDS)
  const fm = fields.mode
  const rq = (key: string) => fm(key) === 'mandatory'
  const [kind, setKind] = useState<'lead' | 'customer'>('lead')
  const [lead, setLead] = useState<Lead | null>(null)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [due, setDue] = useState(() => {
    if (existing) return isoToLocalInput(existing.due_at)
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(10, 0, 0, 0)
    return isoToLocalInput(tomorrow.toISOString())
  })
  const [ownerId, setOwnerId] = useState(existing?.owner_id ?? '')
  const [purpose, setPurpose] = useState(existing?.purpose ?? '')
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const picked = kind === 'lead' ? lead : customer

  async function save() {
    if (!picked && !existing) {
      setError(`Choose the ${kind} this follow-up is for.`)
      return
    }
    if (!due) {
      setError('Choose when the follow-up is due.')
      return
    }
    if (rq('owner') && !ownerId) {
      setError('Choose who owns this follow-up.')
      return
    }
    if (rq('purpose') && !purpose.trim()) {
      setError('Say what the follow-up is for.')
      return
    }
    if (rq('notes') && !notes.trim()) {
      setError('Add the notes for this follow-up.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (existing) {
        await crm.updateFollowUp(existing.id, {
          due_at: localToISO(due), owner_id: ownerId || null,
          purpose: purpose.trim() || null, notes: notes.trim() || null,
        })
      } else if (picked) {
        await crm.createFollowUp({
          lead_id: kind === 'lead' ? picked.id : null,
          customer_id: kind === 'customer' ? picked.id : null,
          due_at: localToISO(due),
          owner_id: ownerId || null,
          purpose: purpose.trim() || null,
          notes: notes.trim() || null,
        })
      }
      onDone()
    } catch (err) {
      setError(crmError(err, 'That follow-up could not be added'))
      setBusy(false)
    }
  }

  /* Every configurable field as an element, so the order a person arranged in
     Settings can place them. A hidden field is nothing at all. */
  const fieldNodes: Record<string, ReactNode> = {
    due: (
          <Field label="Due" required>
          <input type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} />
        </Field>
        ),
    owner: fm('owner') !== 'hide' && (
          <Field label="Owner" required={rq('owner')}>
          <OwnerSelect value={ownerId} onChange={setOwnerId} placeholder="Select owner" />
        </Field>
        ),
    purpose: fm('purpose') !== 'hide' && (
          <Field label="Purpose" wide required={rq('purpose')}>
          <input value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="Call back about the demo" />
        </Field>
        ),
    notes: fm('notes') !== 'hide' && (
          <Field label="Notes" wide required={rq('notes')}>
          <textarea placeholder="e.g. Customer asked for a revised quote" value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} />
        </Field>
        ),
  }
  const fieldsOf = (section: string) =>
    fields.orderOf(section).map((key) => <Fragment key={key}>{fieldNodes[key]}</Fragment>)

  return (
    <Dialog
      title={existing ? 'Edit follow-up' : 'Add follow-up'}
      subtitle={existing ? `${existing.subject_name ?? 'Contact'} · ${existing.subject_kind === 'customer' ? 'Customer' : 'Lead'}` : undefined}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : existing ? 'Save changes' : 'Add follow-up'}
          </button>
        </>
      }
    >
      <div className="crm-form">
        <div className="crm-form-wide lf-settings">
          <FieldSettings defs={FOLLOW_UP_FIELDS} sections={FOLLOW_UP_SECTIONS} modes={fields.modes} order={fields.order}
                         onSave={fields.save} onReset={fields.reset} title="Follow-up fields" />
        </div>
        {error && (
          <div className="crm-form-wide">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}
        {!existing && <div className="crm-field crm-form-wide">
          <span className="crm-field-label">Follow-up for<span className="lf-req"> *</span></span>
          <div className="fu-for" role="radiogroup" aria-label="Follow-up for">
            {(['lead', 'customer'] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={kind === option}
                className={kind === option ? 'is-on' : undefined}
                onClick={() => setKind(option)}
              >
                {option === 'lead' ? <IconUser size={16} /> : <IconBuilding size={16} />}
                {option === 'lead' ? 'Lead' : 'Customer'}
              </button>
            ))}
          </div>
        </div>}
        {!existing && <div className="crm-field crm-form-wide">
          <span className="crm-field-label">{kind === 'lead' ? 'Lead' : 'Customer'}<span className="lf-req"> *</span></span>
          {kind === 'lead' ? (
            <LeadPicker value={lead} onPick={(l) => { setLead(l); if (l?.owner_id) setOwnerId(l.owner_id) }} autoFocus />
          ) : (
            <CustomerPicker value={customer} onPick={(c) => { setCustomer(c); if (c?.manager_id) setOwnerId(c.manager_id) }} autoFocus />
          )}
        </div>}
        {fieldsOf('details')}
        
        
        
      </div>
    </Dialog>
  )
}

/* ----------------------------------------------------------------- import --- */

const SAMPLE_CSV =
  'Contact,Due date,Time,Purpose,Notes\n' +
  'L-0001,2026-11-03,10:30,Send the quotation,Asked for annual pricing\n' +
  '9876543210,03-11-2026,15:00,Demo call,\n'

/** "2026-11-03", "03-11-2026" or "03/11/2026", plus an optional "15:00", to
 *  the moment it means on this computer's clock. */
function parseDue(day: string, at: string): string | null {
  const iso = day.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  const dmy = day.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/)
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : dmy ? [dmy[3], dmy[2], dmy[1]] : []
  if (!y) return null
  const time = (at || '10:00').match(/^(\d{1,2}):(\d{2})/)
  if (!time) return null
  const when = new Date(Number(y), Number(m) - 1, Number(d), Number(time[1]), Number(time[2]))
  return Number.isNaN(when.getTime()) || when.getDate() !== Number(d) ? null : when.toISOString()
}

/** CSV import. Parsed in the browser and posted as rows, as on My Leads; the
 *  server matches each contact by Lead ID, customer code or mobile. */
function ImportFollowUpsDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<Array<Record<string, string>>>([])
  const [fileName, setFileName] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ created: number; errors: string[] } | null>(null)

  async function readFile(file: File) {
    setError(null)
    setResult(null)
    const lines = (await file.text()).split(/\r?\n/).filter((line) => line.trim())
    if (lines.length < 2) {
      setError('That file has a header but no rows.')
      return
    }
    const header = splitCsvLine(lines[0]).map((cell) => cell.trim().toLowerCase())
    setRows(
      lines.slice(1).map((line) => {
        const cells = splitCsvLine(line)
        const row: Record<string, string> = {}
        header.forEach((column, index) => {
          row[column] = (cells[index] ?? '').trim()
        })
        return row
      }),
    )
    setFileName(file.name)
  }

  const parsed = rows.map((row) => {
    const contact = row.contact || row['lead id'] || row['customer code'] || row.mobile || ''
    const due = parseDue(row['due date'] || row.date || row.due || '', row.time || '')
    return { contact, due, purpose: row.purpose || '', notes: row.notes || '' }
  })
  const usable = parsed.filter((row) => row.contact && row.due)

  function downloadSample() {
    const url = URL.createObjectURL(new Blob([SAMPLE_CSV], { type: 'text/csv' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'follow-ups-sample.csv'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  async function run() {
    setBusy(true)
    setError(null)
    try {
      const out = await crm.importFollowUps({
        rows: usable.map((row) => ({
          contact: row.contact,
          due_at: row.due,
          purpose: row.purpose || null,
          notes: row.notes || null,
        })),
        owner_id: ownerId || null,
      })
      if (out.errors.length === 0) {
        onDone()
        return
      }
      setResult(out)
    } catch (err) {
      setError(crmError(err, 'The import failed'))
    }
    setBusy(false)
  }

  return (
    <Dialog
      title="Import follow-ups"
      subtitle="A CSV with a header row: Contact (Lead ID, customer code or mobile), Due date, and optionally Time, Purpose, Notes."
      onClose={result ? onDone : onClose}
      footer={
        result ? (
          <button className="btn btn-primary" onClick={onDone}>
            Done
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose} type="button">
              Cancel
            </button>
            <button className="btn btn-primary" onClick={run} disabled={busy || usable.length === 0}>
              {busy ? 'Importing…' : `Import ${usable.length} follow-up${usable.length === 1 ? '' : 's'}`}
            </button>
          </>
        )
      }
    >
      <div className="crm-form">
        <Field label="File" wide hint={<button type="button" className="link-btn" onClick={downloadSample}>Download a sample file</button>}>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void readFile(file)
            }}
          />
        </Field>
        <Field label="Owner" hint="Left empty, each goes to its record's owner." wide>
          <OwnerSelect value={ownerId} onChange={setOwnerId} placeholder="Record's owner" />
        </Field>

        {error && (
          <div className="crm-form-wide">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}
        {result && (
          <div className="crm-form-wide">
            <ErrorNote>
              <div>
                {result.created} added. {result.errors.length} row{result.errors.length === 1 ? ' was' : 's were'} refused:
              </div>
              <ul>
                {result.errors.slice(0, 8).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </ErrorNote>
          </div>
        )}

        {fileName && !result && (
          <div className="crm-form-wide">
            <p className="crm-sub">
              {fileName} — {usable.length} usable row{usable.length === 1 ? '' : 's'}
              {parsed.length !== usable.length &&
                `, ${parsed.length - usable.length} skipped for a missing contact or an unreadable date`}
            </p>
            <div className="table-wrap" style={{ maxHeight: 220 }}>
              <table>
                <thead>
                  <tr>
                    <th>Contact</th>
                    <th>Due</th>
                    <th>Purpose</th>
                  </tr>
                </thead>
                <tbody>
                  {usable.slice(0, 25).map((row, index) => (
                    <tr key={`${row.contact}-${index}`}>
                      <td>{row.contact}</td>
                      <td>{new Date(row.due!).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                      <td>{row.purpose || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}

/** Close one follow-up, and — in the same action — book the next and move the
 *  lead's stage. Three requests would be three chances for the second to fail
 *  after the first succeeded, and the person is standing at their desk with the
 *  phone still warm. */
function CompleteDialog({
  followUp,
  onClose,
  onDone,
}: {
  followUp: FollowUp
  onClose: () => void
  onDone: () => void
}) {
  const [outcome, setOutcome] = useState('')
  const [bookNext, setBookNext] = useState(false)
  const [nextDue, setNextDue] = useState(() => {
    const soon = new Date()
    soon.setDate(soon.getDate() + 3)
    soon.setHours(10, 0, 0, 0)
    return isoToLocalInput(soon.toISOString())
  })
  const [nextPurpose, setNextPurpose] = useState('')
  const [statusId, setStatusId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await crm.completeFollowUp(followUp.id, {
        outcome: outcome || null,
        next_due_at: bookNext ? localToISO(nextDue) : null,
        next_purpose: bookNext ? nextPurpose || null : null,
        status_id: statusId || null,
      })
      onDone()
    } catch (err) {
      setError(crmError(err, 'That follow-up could not be closed'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={`Complete: ${followUp.subject_name ?? 'follow-up'}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Mark complete'}
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
        <Field label="What happened?" wide>
          <textarea
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
            rows={3}
            placeholder="Spoke to the owner, wants a quotation by Friday…"
            autoFocus
          />
        </Field>

        {followUp.lead_id && (
          <Field label="Move the lead to" hint="Leave it alone if the stage has not changed.">
            <MasterSelect kind="statuses" value={statusId} onChange={setStatusId} placeholder="No change" />
          </Field>
        )}

        <div className="crm-field">
          <span className="crm-field-label">Next call</span>
          <label className="crm-check">
            <input
              type="checkbox"
              checked={bookNext}
              onChange={(event) => setBookNext(event.target.checked)}
            />
            Book the next follow-up now
          </label>
        </div>

        {bookNext && (
          <>
            <Field label="When">
              <input
                type="datetime-local"
                value={nextDue}
                onChange={(event) => setNextDue(event.target.value)}
              />
            </Field>
            <Field label="Purpose">
              <input
                value={nextPurpose}
                onChange={(event) => setNextPurpose(event.target.value)}
                placeholder="Send the quotation"
              />
            </Field>
          </>
        )}
      </div>
    </Dialog>
  )
}
