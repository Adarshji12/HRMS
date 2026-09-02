/* My Follow-ups — everything owed to somebody, and when.
 *
 * This is the page a salesperson lives in, so it opens on the shortest useful
 * answer: what is pending, soonest first, overdue at the top and coloured.
 * Nothing here is a second copy of a lead — completing a follow-up can move the
 * lead's stage and book the next call in the same action, because that is one
 * act to the person doing it: they have just put the phone down.
 */

import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import '../../styles/crm.css'
import { useQuery } from '../../lib/useQuery'
import { relativeTime } from '../../lib/format'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconAlert, IconCheck, IconClock, IconReturn, IconSearch } from '../../components/Icons'
import {
  crm,
  crmError,
  isoToLocalInput,
  localToISO,
  type FollowUp,
} from './api'
import {
  CrmPage,
  Dialog,
  DueDate,
  Field,
  MasterSelect,
  OwnerSelect,
  Stat,
  StateText,
  Stats,
  WhatsAppButton,
} from './parts'

const WINDOWS = [
  { key: '', label: 'All pending' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Due today' },
  { key: 'week', label: 'Next 7 days' },
  { key: 'upcoming', label: 'Upcoming' },
]

export default function MyFollowUps() {
  const [params] = useSearchParams()
  const [window, setWindow] = useState(params.get('window') ?? '')
  const [status, setStatus] = useState<'pending' | 'done' | 'cancelled'>('pending')
  const [ownerId, setOwnerId] = useState('')
  const [q, setQ] = useState('')
  const [completing, setCompleting] = useState<FollowUp | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)

  const rows = useQuery<FollowUp[]>(
    `crm-followups-${status}-${window}-${ownerId}-${q}`,
    () =>
      crm.followUps({
        status,
        window: window || undefined,
        owner_id: ownerId || undefined,
        q: q.trim() || undefined,
      }),
  )

  const list = rows.data ?? []
  const overdue = list.filter((row) => row.is_overdue).length
  const today = list.filter((row) => {
    const due = new Date(row.due_at)
    return due.toDateString() === new Date().toDateString()
  }).length

  async function cancel(row: FollowUp) {
    setRowError(null)
    try {
      await crm.cancelFollowUp(row.id)
      rows.reload()
    } catch (err) {
      setRowError(crmError(err, 'That follow-up could not be cancelled'))
    }
  }

  if (rows.error && !rows.data) {
    return (
      <CrmPage title="My Follow-ups">
        <ErrorNote>{crmError(rows.cause, 'Could not load your follow-ups')}</ErrorNote>
      </CrmPage>
    )
  }

  return (
    <CrmPage
      title="My Follow-ups"
      subtitle="Everything you promised to get back to, in the order it is due"
    >
      <Stats>
        <Stat
          icon={<IconClock size={16} />}
          label="Pending"
          value={status === 'pending' ? list.length : '—'}
          meta="in this view"
        />
        <Stat
          icon={<IconAlert size={16} />}
          label="Overdue"
          value={overdue}
          meta={overdue ? 'call these first' : 'nothing late'}
          tone="var(--status-critical)"
          toned={overdue > 0}
        />
        <Stat
          icon={<IconReturn size={16} />}
          label="Due today"
          value={today}
          tone="var(--status-warn)"
          toned={today > 0}
        />
      </Stats>

      <div className="crm-bar">
        <div className="crm-search">
          <IconSearch size={15} />
          <input
            type="search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Search a name, number or purpose…"
            aria-label="Search follow-ups"
          />
        </div>
        <div className="crm-seg">
          {WINDOWS.map((option) => (
            <button
              key={option.key || 'all'}
              className={window === option.key ? 'crm-seg-on' : ''}
              onClick={() => setWindow(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
          aria-label="Status"
        >
          <option value="pending">Pending</option>
          <option value="done">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <OwnerSelect value={ownerId} onChange={setOwnerId} placeholder="Anyone" />
      </div>

      {rowError && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{rowError}</ErrorNote>
        </div>
      )}

      <section className="card" style={{ opacity: rows.refetching ? 0.6 : 1 }}>
        {list.length === 0 ? (
          rows.loading ? (
            <Loading />
          ) : (
            <EmptyState
              icon={<IconCheck size={22} />}
              title={status === 'pending' ? 'Nothing is owed right now' : 'Nothing here'}
              body={
                status === 'pending'
                  ? 'Every call you promised has been made. Book the next one from a lead or from the support desk and it will appear here.'
                  : 'Change the filter above to see what is pending.'
              }
            />
          )
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Due</th>
                  <th>Who</th>
                  <th>Purpose</th>
                  <th>Owner</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map((row) => (
                  <tr key={row.id}>
                    <td className="crm-nowrap">
                      <DueDate iso={row.due_at} overdue={row.is_overdue} />
                      <div className="crm-sub">{relativeTime(row.due_at)}</div>
                    </td>
                    <td>
                      <div className="crm-strong">{row.subject_name ?? '—'}</div>
                      <div className="crm-sub">
                        {row.subject_kind === 'customer' ? 'Customer' : 'Lead'}
                        {row.subject_mobile ? ` · ${row.subject_mobile}` : ''}
                      </div>
                    </td>
                    <td>
                      {row.purpose ?? <span className="crm-muted">—</span>}
                      {row.notes && <div className="crm-sub">{row.notes}</div>}
                      {row.outcome && <div className="crm-sub">Outcome: {row.outcome}</div>}
                    </td>
                    <td>{row.owner_name ?? <span className="crm-muted">Unassigned</span>}</td>
                    <td>
                      <StateText value={row.status} />
                    </td>
                    <td>
                      <div className="crm-row-actions">
                        <WhatsAppButton mobile={row.subject_mobile} />
                        {row.status === 'pending' && (
                          <>
                            <button
                              className="btn btn-sm btn-primary"
                              onClick={() => setCompleting(row)}
                            >
                              Complete
                            </button>
                            <button className="link-btn" onClick={() => cancel(row)}>
                              Cancel
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {completing && (
        <CompleteDialog
          followUp={completing}
          onClose={() => setCompleting(null)}
          onDone={() => {
            setCompleting(null)
            rows.reload()
          }}
        />
      )}
    </CrmPage>
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
