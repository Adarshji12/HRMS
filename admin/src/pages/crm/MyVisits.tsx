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

import { useState } from 'react'
import '../../styles/crm.css'
import { useQuery } from '../../lib/useQuery'
import { dateTime } from '../../lib/format'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconClose,
  IconFilter,
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
  Stat,
  StateText,
  Stats,
  WhatsAppButton,
} from './parts'

const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const

export default function MyVisits() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [typeId, setTypeId] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [showFilters, setShowFilters] = useState(false)
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

  const rows = visits.data ?? []

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

  return (
    <CrmPage
      title="My Visits"
      subtitle="Every field call — service, sales, support and the rest"
      actions={
        <button className="btn btn-primary" onClick={() => setBooking(true)}>
          <IconPlus size={15} /> New Visit
        </button>
      }
    >
      <Stats>
        <Stat label="Today" value={s?.today ?? 0} icon={<IconClock size={16} />} />
        <Stat label="Pending" value={s?.pending ?? 0} icon={<IconClock size={16} />} />
        <Stat
          label="In Progress"
          value={s?.in_progress ?? 0}
          icon={<IconClock size={16} />}
          tone="var(--status-warn)"
          toned={Boolean(s?.in_progress)}
        />
        <Stat
          label="Completed"
          value={s?.completed ?? 0}
          icon={<IconCheck size={16} />}
          tone="var(--status-good)"
          toned={Boolean(s?.completed)}
        />
        <Stat
          label="Overdue"
          value={s?.overdue ?? 0}
          meta={s?.overdue ? 'scheduled, never started' : undefined}
          icon={<IconAlert size={16} />}
          tone="var(--status-critical)"
          toned={Boolean(s?.overdue)}
        />
        <Stat label="Cancelled" value={s?.cancelled ?? 0} icon={<IconClose size={16} />} />
      </Stats>

      <div className="crm-bar">
        <div className="crm-search">
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
        <button className="crm-tab" onClick={() => setShowFilters((open) => !open)}>
          <IconFilter size={14} /> Filters
        </button>
        {(q || status || typeId || employeeId || from || to) && (
          <button
            className="filter-reset crm-push"
            onClick={() => {
              setQ('')
              setStatus('')
              setTypeId('')
              setEmployeeId('')
              setFrom('')
              setTo('')
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {showFilters && (
        <section className="card" style={{ marginBottom: 14, padding: 14 }}>
          <div className="crm-grid-4">
            <Field label="Employee">
              <OwnerSelect value={employeeId} onChange={setEmployeeId} placeholder="Anyone" />
            </Field>
            <Field label="Scheduled from">
              <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </Field>
            <Field label="Scheduled to">
              <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </Field>
          </div>
        </section>
      )}

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

      <section className="card" style={{ opacity: visits.refetching ? 0.6 : 1 }}>
        {rows.length === 0 ? (
          visits.loading ? (
            <Loading />
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
              <table>
                <thead>
                  <tr>
                    <th>Visit no</th>
                    <th>Customer</th>
                    <th>Type</th>
                    <th>Employee</th>
                    <th>Scheduled</th>
                    <th>Priority</th>
                    <th>Status</th>
                    <th>Duration</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((visit) => (
                    <tr key={visit.id}>
                      <td className="crm-code">{visit.visit_no}</td>
                      <td>
                        <div className="crm-strong">{visit.customer_name}</div>
                        <div className="crm-sub">{visit.mobile ?? visit.customer_mobile}</div>
                      </td>
                      <td>{visit.visit_type_name ?? <span className="crm-muted">—</span>}</td>
                      <td>
                        {visit.employee_name ?? <span className="crm-muted">Unassigned</span>}
                      </td>
                      <td className="crm-nowrap">{dateTime(visit.scheduled_at)}</td>
                      <td>
                        <span className="crm-pill">{visit.priority}</span>
                      </td>
                      <td>
                        <StateText value={visit.status} />
                        {visit.otp_required && (
                          <div className="crm-sub">
                            {visit.otp_verified ? 'arrival verified' : 'needs an arrival code'}
                          </div>
                        )}
                      </td>
                      <td className="crm-num">
                        {visit.duration_minutes !== null ? `${visit.duration_minutes}m` : '—'}
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
    </CrmPage>
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
