/* My Visits — every field call, whatever kind it is.
 *
 * A visit is booked against an existing customer and nothing else. That is a
 * deliberate constraint rather than a missing feature: a visit to somebody who
 * is not on the system has no record to attach the outcome to, and the fix is
 * thirty seconds on My Customers, not a second half-built customer table here.
 *
 * The OTP is proof of arrival, not authentication. The code is minted here and
 * *shown* — this product has no SMS channel, so whoever is dispatching sends it
 * however they already talk to the customer, and the employee types back what
 * they were told. Saying that plainly on the screen is better than a button
 * labelled "Send OTP" that sends nothing.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import '../../styles/crm.css'
import '../../styles/visits.css'
import '../../styles/hrdash.css'
import { useQuery } from '../../lib/useQuery'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import {
  IconAlert,
  IconCalendar,
  IconCheck,
  IconClock,
  IconClose,
  IconFilter,
  IconPin,
  IconPlus,
  IconSearch,
} from '../../components/Icons'
import {
  crm,
  crmError,
  isoToLocalInput,
  localToISO,
  type Customer,
  type Visit,
} from './api'
import {
  CrmPage,
  CustomerPicker,
  Dialog,
  Field,
  MasterSelect,
  OwnerSelect,
  StateText,
  WhatsAppButton,
} from './parts'

const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const

const todayISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const initials = (name: string | null | undefined) =>
  (name ?? '?').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?'

/** Date over time, so a column of visits reads down by day. */
function When({ iso }: { iso: string | null }) {
  if (!iso) return <span className="crm-muted">—</span>
  const d = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`)
  return (
    <span className="vs-when">
      <span>{d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}</span>
      <span className="crm-sub">{d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
    </span>
  )
}

type StripKey = 'today' | 'scheduled' | 'in_progress' | 'completed' | 'overdue' | 'cancelled'

/* The six counts on one line. A segment that maps to a filter is a button —
   Today narrows to today's date, the statuses to that status — and clicking
   the active one again clears it. Overdue has no filter behind it on the
   server, so it is a figure only. */
function VisitStrip(p: {
  today: number; pending: number; inProgress: number; completed: number
  overdue: number; cancelled: number
  status: string; isToday: boolean
  pick: (key: Exclude<StripKey, 'overdue'>) => void
}) {
  const items: Array<{ key: StripKey; label: string; value: number; tone: string; hint: string; icon: ReactNode }> = [
    { key: 'today', label: 'Today', value: p.today, tone: 'brand', hint: 'Booked for today', icon: <IconCalendar size={16} /> },
    { key: 'scheduled', label: 'Pending', value: p.pending, tone: 'idle', hint: 'Scheduled, not started', icon: <IconClock size={16} /> },
    { key: 'in_progress', label: 'In progress', value: p.inProgress, tone: 'warn', hint: 'Checked in on site', icon: <IconPin size={16} /> },
    { key: 'completed', label: 'Completed', value: p.completed, tone: 'good', hint: 'Closed with an outcome', icon: <IconCheck size={16} /> },
    { key: 'overdue', label: 'Overdue', value: p.overdue, tone: p.overdue ? 'bad' : 'idle', hint: p.overdue ? 'Scheduled, never started' : 'Nothing late', icon: <IconAlert size={16} /> },
    { key: 'cancelled', label: 'Cancelled', value: p.cancelled, tone: 'idle', hint: 'Called off', icon: <IconClose size={16} /> },
  ]
  return (
    <div className="hrd-kpis crm-kpis" role="group" aria-label="Visit summary">
      {items.map((it) => {
        const on = it.key === 'today' ? p.isToday : it.key === p.status
        const body = (
          <>
            <span className="hrd-kpi-top">
              <span className="hrd-kpi-label">{it.label}</span>
              <span className="hrd-kpi-icon" aria-hidden>{it.icon}</span>
            </span>
            <span className="hrd-kpi-value">{it.value}</span>
            <span className="hrd-kpi-hint">{it.hint}</span>
          </>
        )
        return it.key === 'overdue' ? (
          <div key={it.key} className={`hrd-kpi tone-${it.tone}`}>{body}</div>
        ) : (
          <button
            key={it.key}
            type="button"
            className={`hrd-kpi cu-kpi tone-${it.tone}${on ? ' is-on' : ''}`}
            aria-pressed={on}
            onClick={() => p.pick(it.key as Exclude<StripKey, 'overdue'>)}
          >
            {body}
          </button>
        )
      })}
    </div>
  )
}

export default function MyVisits() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [typeId, setTypeId] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const [booking, setBooking] = useState(false)
  const [editing, setEditing] = useState<Visit | null>(null)
  const [closing, setClosing] = useState<Visit | null>(null)
  const [checkingIn, setCheckingIn] = useState<Visit | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)

  const key = `crm-visits-${q}-${status}-${typeId}-${employeeId}-${from}-${to}`
  const visits = useQuery<Visit[]>(key, () =>
    crm.visits({
      q: q.trim() || undefined,
      status: status || undefined,
      visit_type_id: typeId || undefined,
      employee_id: employeeId || undefined,
      date_from: from || undefined,
      date_to: to || undefined,
    }),
  )
  const summary = useQuery('crm-visit-summary', () => crm.visitSummary())

  // Priority is narrowed here rather than on the server: the list endpoint has
  // no priority parameter, and the rows are already on the page.
  const rows = (visits.data ?? []).filter((v) => !priorityFilter || v.priority === priorityFilter)

  /* The More filters panel closes on a click outside it or on Escape. */
  useEffect(() => {
    if (!showFilters) return
    const onDown = (e: MouseEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setShowFilters(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowFilters(false) }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [showFilters])

  const moreCount = [employeeId, priorityFilter, from, to].filter(Boolean).length
  function clearMore() {
    setEmployeeId('')
    setPriorityFilter('')
    setFrom('')
    setTo('')
  }

  async function cancel(visit: Visit) {
    setRowError(null)
    try {
      await crm.cancelVisit(visit.id)
      visits.reload()
      summary.reload()
    } catch (err) {
      setRowError(crmError(err, 'That visit could not be cancelled'))
    }
  }

  async function start(visit: Visit) {
    if (visit.otp_required) {
      setCheckingIn(visit)
      return
    }
    setRowError(null)
    try {
      await crm.startVisit(visit.id, {})
      visits.reload()
      summary.reload()
    } catch (err) {
      setRowError(crmError(err, 'That visit could not be started'))
    }
  }

  if (visits.error && !visits.data) {
    return (
      <CrmPage title="My Visits">
        <ErrorNote>{crmError(visits.cause, 'Could not load your visits')}</ErrorNote>
      </CrmPage>
    )
  }

  const s = summary.data
  const filtered = Boolean(q || status || typeId || employeeId || priorityFilter || from || to)

  return (
    /* No page heading: "My Visit" is the tab above. New Visit sits in the
       toolbar with the filters. */
    <div className="crm">
      <VisitStrip
        today={s?.today ?? 0}
        pending={s?.pending ?? 0}
        inProgress={s?.in_progress ?? 0}
        completed={s?.completed ?? 0}
        overdue={s?.overdue ?? 0}
        cancelled={s?.cancelled ?? 0}
        status={status}
        isToday={Boolean(from) && from === to && from === todayISO()}
        pick={(next) => {
          if (next === 'today') {
            const t = todayISO()
            const on = from === t && to === t
            setFrom(on ? '' : t)
            setTo(on ? '' : t)
            setStatus('')
          } else {
            setStatus(status === next ? '' : next)
          }
        }}
      />

      {banner && (
        <div className="notice notice-ok" style={{ marginBottom: 12 }}>
          {banner}
          <button className="link-btn" onClick={() => setBanner(null)}>
            Dismiss
          </button>
        </div>
      )}
      {rowError && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{rowError}</ErrorNote>
        </div>
      )}

      <section className="card vs-card">
        <div className="vs-toolbar">
          <div className="crm-search vs-search">
            <IconSearch size={15} />
            <input
              type="search"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="Search visit no, customer, mobile, purpose…"
              aria-label="Search visits"
            />
          </div>
          <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Status">
            <option value="">All statuses</option>
            <option value="scheduled">Scheduled</option>
            <option value="in_progress">In progress</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <MasterSelect kind="visit-types" value={typeId} onChange={setTypeId} placeholder="All visit types" />
          <div className="vs-more" ref={moreRef}>
            <button
              className={`btn vs-filter-btn${showFilters || moreCount ? ' is-on' : ''}`}
              onClick={() => setShowFilters((open) => !open)}
              aria-expanded={showFilters}
              aria-haspopup="dialog"
            >
              <IconFilter size={14} /> More filters
              {moreCount > 0 && <span className="vs-more-count">{moreCount}</span>}
            </button>
            {showFilters && (
              <div className="vs-pop" role="dialog" aria-label="More filters">
                <label className="vs-pop-field">
                  <span>Employee</span>
                  <OwnerSelect value={employeeId} onChange={setEmployeeId} placeholder="Everyone" />
                </label>
                <label className="vs-pop-field">
                  <span>Priority</span>
                  <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}>
                    <option value="">Any priority</option>
                    {PRIORITIES.map((level) => (
                      <option key={level} value={level}>
                        {level.charAt(0).toUpperCase() + level.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="vs-pop-dates">
                  <label className="vs-pop-field">
                    <span>Scheduled from</span>
                    <input type="date" value={from} max={to || undefined}
                           onChange={(event) => setFrom(event.target.value)} />
                  </label>
                  <label className="vs-pop-field">
                    <span>to</span>
                    <input type="date" value={to} min={from || undefined}
                           onChange={(event) => setTo(event.target.value)} />
                  </label>
                </div>
                <button type="button" className="vs-pop-clear" onClick={clearMore} disabled={moreCount === 0}>
                  Clear all filters
                </button>
              </div>
            )}
          </div>
          {filtered && (
            <button
              className="filter-reset"
              onClick={() => {
                setQ('')
                setStatus('')
                setTypeId('')
                setEmployeeId('')
                setPriorityFilter('')
                setFrom('')
                setTo('')
              }}
            >
              Clear all
            </button>
          )}
          <button className="btn btn-primary vs-new" onClick={() => setBooking(true)}>
            <IconPlus size={14} /> New Visit
          </button>
        </div>

        <div style={{ opacity: visits.refetching ? 0.6 : 1 }}>
          {rows.length === 0 ? (
            visits.loading ? (
              <Loading />
            ) : filtered ? (
              <EmptyState
                icon={<IconSearch size={22} />}
                title="No visits match"
                body="Nothing fits these filters. Widen the dates or clear them to see every visit."
              />
            ) : (
              <EmptyState
                icon={<IconClock size={22} />}
                title="No visits booked"
                body="Book a field call against a customer — service, sales, a demo or a collection. Whoever it is assigned to sees it in their own list."
                action={
                  <button className="btn btn-primary" onClick={() => setBooking(true)}>
                    Book the first visit
                  </button>
                }
              />
            )
          ) : (
            <>
              <div className="table-wrap">
                <table className="vs-table">
                  <thead>
                    <tr>
                      <th>Visit</th>
                      <th>Customer</th>
                      <th>Assigned to</th>
                      <th>Scheduled</th>
                      <th>Priority</th>
                      <th>Status</th>
                      <th style={{ textAlign: 'right' }}>Duration</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((visit) => (
                      <tr key={visit.id}>
                        <td>
                          <div className="crm-code">{visit.visit_no}</div>
                          <div className="crm-sub">{visit.visit_type_name ?? 'No type'}</div>
                        </td>
                        <td>
                          <div className="vs-who">
                            <span className="vs-avatar" aria-hidden>{initials(visit.customer_name)}</span>
                            <span className="vs-who-text">
                              <span className="crm-strong">{visit.customer_name}</span>
                              <span className="crm-sub">{visit.mobile ?? visit.customer_mobile}</span>
                            </span>
                          </div>
                        </td>
                        <td>
                          {visit.employee_name ?? <span className="crm-muted">Unassigned</span>}
                        </td>
                        <td className="crm-nowrap">
                          <When iso={visit.scheduled_at} />
                        </td>
                        <td>
                          <span className={`vs-priority is-${visit.priority}`}>{visit.priority}</span>
                        </td>
                        <td>
                          <StateText value={visit.status} />
                          {visit.otp_required && (
                            <div className="crm-sub">
                              {visit.otp_verified ? 'Arrival verified' : 'Needs arrival code'}
                            </div>
                          )}
                        </td>
                        <td className="crm-num">
                          {visit.duration_minutes !== null ? `${visit.duration_minutes} min` : '—'}
                        </td>
                        <td>
                          <div className="crm-row-actions">
                            <WhatsAppButton mobile={visit.mobile ?? visit.customer_mobile} />
                            {visit.status === 'scheduled' && (
                              <>
                                {visit.otp_required && (
                                  <button
                                    className="link-btn"
                                    onClick={async () => {
                                      setRowError(null)
                                      try {
                                        const { otp } = await crm.issueOtp(visit.id)
                                        setBanner(
                                          `Arrival code for ${visit.visit_no}: ${otp}. Send it to the customer — the product has no SMS channel, so nothing was sent for you.`,
                                        )
                                        visits.reload()
                                      } catch (err) {
                                        setRowError(crmError(err, 'A code could not be issued'))
                                      }
                                    }}
                                  >
                                    Get code
                                  </button>
                                )}
                                <button className="btn btn-sm" onClick={() => start(visit)}>
                                  Check in
                                </button>
                              </>
                            )}
                            {visit.status === 'in_progress' && (
                              <button className="btn btn-sm btn-primary" onClick={() => setClosing(visit)}>
                                Close
                              </button>
                            )}
                            {(visit.status === 'scheduled' || visit.status === 'in_progress') && (
                              <button className="link-btn" onClick={() => cancel(visit)}>
                                Cancel
                              </button>
                            )}
                            <button className="link-btn" onClick={() => setEditing(visit)}>
                              Edit
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
                  Showing {rows.length} visit{rows.length === 1 ? '' : 's'}
                </span>
              </div>
            </>
          )}
        </div>
      </section>

      {(booking || editing) && (
        <VisitForm
          visit={editing}
          onClose={() => {
            setBooking(false)
            setEditing(null)
          }}
          onSaved={() => {
            setBooking(false)
            setEditing(null)
            visits.reload()
            summary.reload()
          }}
        />
      )}

      {checkingIn && (
        <CheckInDialog
          visit={checkingIn}
          onClose={() => setCheckingIn(null)}
          onDone={() => {
            setCheckingIn(null)
            visits.reload()
            summary.reload()
          }}
        />
      )}

      {closing && (
        <CloseVisitDialog
          visit={closing}
          onClose={() => setClosing(null)}
          onDone={() => {
            setClosing(null)
            visits.reload()
            summary.reload()
          }}
        />
      )}
    </div>
  )
}

function VisitForm({
  visit,
  onClose,
  onSaved,
}: {
  visit: Visit | null
  onClose: () => void
  onSaved: () => void
}) {
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [contact, setContact] = useState(visit?.contact_person ?? '')
  const [mobile, setMobile] = useState(visit?.mobile ?? '')
  const [address, setAddress] = useState(visit?.address ?? '')
  const [typeId, setTypeId] = useState(visit?.visit_type_id ?? '')
  const [priority, setPriority] = useState(visit?.priority ?? 'medium')
  const [purpose, setPurpose] = useState(visit?.purpose ?? '')
  const [assignee, setAssignee] = useState(visit?.assigned_to ?? '')
  const [when, setWhen] = useState(
    visit ? isoToLocalInput(visit.scheduled_at) : isoToLocalInput(new Date().toISOString()),
  )
  const [notes, setNotes] = useState(visit?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    const body = {
      customer_id: customer?.id ?? visit?.customer_id,
      contact_person: contact || null,
      mobile: mobile || null,
      address: address || null,
      visit_type_id: typeId || null,
      priority,
      purpose: purpose || null,
      notes: notes || null,
      assigned_to: assignee || null,
      scheduled_at: localToISO(when),
    }
    try {
      if (visit) await crm.patchVisit(visit.id, body)
      else await crm.createVisit(body)
      onSaved()
    } catch (err) {
      setError(crmError(err, 'That visit could not be saved'))
      setBusy(false)
    }
  }

  const ready = Boolean((customer || visit) && when)

  return (
    <Dialog
      title={visit ? `Edit ${visit.visit_no}` : 'New Visit'}
      subtitle="Book any kind of field call — service, sales, collection, a demo — against an existing customer."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !ready}>
            {busy ? 'Saving…' : visit ? 'Save changes' : 'Create Visit'}
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

        <div className="crm-field crm-form-wide">
          <span className="crm-field-label">Customer *</span>
          {visit ? (
            <div className="crm-fact-value">
              <span className="crm-strong">{visit.customer_name}</span>
              <span className="crm-sub">{visit.customer_mobile}</span>
            </div>
          ) : (
            <CustomerPicker value={customer} onPick={setCustomer} autoFocus />
          )}
        </div>

        <Field label="Contact Person">
          <input
            value={contact}
            onChange={(event) => setContact(event.target.value)}
            placeholder="Who will meet the employee"
          />
        </Field>
        <Field label="Mobile Number" hint="The number the arrival code goes to.">
          <input
            value={mobile}
            onChange={(event) => setMobile(event.target.value)}
            placeholder={customer?.mobile ?? 'Defaults to the customer’s number'}
          />
        </Field>

        <Field label="Address" wide hint="Leave blank to use the address on the customer record.">
          <textarea value={address} onChange={(event) => setAddress(event.target.value)} rows={2} />
        </Field>

        <Field label="Visit Type *">
          <MasterSelect kind="visit-types" value={typeId} onChange={setTypeId} />
        </Field>
        <Field label="Priority">
          <select value={priority} onChange={(event) => setPriority(event.target.value as typeof priority)}>
            {PRIORITIES.map((level) => (
              <option key={level} value={level}>
                {level.charAt(0).toUpperCase() + level.slice(1)}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Visit Purpose / Reason" wide>
          <textarea
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
            rows={2}
            placeholder="What the employee is going there to do"
          />
        </Field>

        <Field label="Assigned Employee">
          <OwnerSelect value={assignee} onChange={setAssignee} placeholder="Leave unassigned" />
        </Field>
        <Field label="Scheduled *">
          <input
            type="datetime-local"
            value={when}
            onChange={(event) => setWhen(event.target.value)}
          />
        </Field>

        <Field label="Notes" wide>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={2}
            placeholder="Anything the employee should know before going"
          />
        </Field>
      </div>
    </Dialog>
  )
}

function CheckInDialog({
  visit,
  onClose,
  onDone,
}: {
  visit: Visit
  onClose: () => void
  onDone: () => void
}) {
  const [otp, setOtp] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await crm.startVisit(visit.id, { otp })
      onDone()
    } catch (err) {
      setError(crmError(err, 'That code was not accepted'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={`Check in — ${visit.visit_no}`}
      subtitle="This visit type needs proof of arrival. Ask the customer for the code they were sent."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || otp.length < 4}>
            {busy ? 'Checking…' : 'Check in'}
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
        <Field label="Arrival code" wide>
          <input
            value={otp}
            onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            placeholder="6 digits"
            autoFocus
          />
        </Field>
      </div>
    </Dialog>
  )
}

function CloseVisitDialog({
  visit,
  onClose,
  onDone,
}: {
  visit: Visit
  onClose: () => void
  onDone: () => void
}) {
  const [outcome, setOutcome] = useState('')
  const [bookNext, setBookNext] = useState(false)
  const [nextAt, setNextAt] = useState(() => {
    const soon = new Date()
    soon.setDate(soon.getDate() + 7)
    soon.setHours(10, 0, 0, 0)
    return isoToLocalInput(soon.toISOString())
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await crm.closeVisit(visit.id, {
        outcome: outcome || null,
        next_follow_up_at: bookNext ? localToISO(nextAt) : null,
      })
      onDone()
    } catch (err) {
      setError(crmError(err, 'That visit could not be closed'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={`Close ${visit.visit_no}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Mark completed'}
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
        <Field label="What happened on site?" wide>
          <textarea
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
            rows={4}
            autoFocus
          />
        </Field>
        <div className="crm-field crm-form-wide">
          <label className="crm-check">
            <input
              type="checkbox"
              checked={bookNext}
              onChange={(event) => setBookNext(event.target.checked)}
            />
            Book a follow-up with this customer
          </label>
        </div>
        {bookNext && (
          <Field label="Follow up on">
            <input
              type="datetime-local"
              value={nextAt}
              onChange={(event) => setNextAt(event.target.value)}
            />
          </Field>
        )}
      </div>
    </Dialog>
  )
}
