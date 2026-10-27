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

import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import '../../styles/crm.css'
import '../../styles/visits.css'
import '../../styles/followups.css'
import '../../styles/hrdash.css'
import { useQuery } from '../../lib/useQuery'
import { relativeTime } from '../../lib/format'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconAlert, IconCalendar, IconCheck, IconClock, IconSearch, IconSheet } from '../../components/Icons'
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
  Field,
  MasterSelect,
  OwnerSelect,
  StateText,
  WhatsAppButton,
} from './parts'

type Window = '' | 'overdue' | 'today' | 'week' | 'upcoming'
type Status = 'pending' | 'done' | 'cancelled'

const STATUSES: Array<{ key: Status; label: string }> = [
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

export default function MyFollowUps() {
  const [params] = useSearchParams()
  const [window, setWindow] = useState<Window>((params.get('window') ?? '') as Window)
  const [status, setStatus] = useState<Status>('pending')
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
  const pending = useQuery<FollowUp[]>(`crm-followups-counts-${ownerId}`, () =>
    crm.followUps({ status: 'pending', owner_id: ownerId || undefined }),
  )

  const list = rows.data ?? []
  const c = countWindows(pending.data ?? [])
  const filtered = Boolean(q || window || ownerId)

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
        {/* Status tabs, search and owner on one line. */}
        <div className="fu-head">
          <div className="fu-tabs" role="tablist" aria-label="Status">
            {STATUSES.map((s) => (
              <button
                key={s.key}
                role="tab"
                aria-selected={status === s.key}
                className={`fu-tab${status === s.key ? ' is-on' : ''}`}
                onClick={() => {
                  setStatus(s.key)
                  if (s.key !== 'pending') setWindow('')
                }}
              >
                {s.label}
                {s.key === 'pending' && pending.data && <span className="fu-tab-count">{c.all}</span>}
              </button>
            ))}
          </div>

          <div className="fu-tools">
          <div className="crm-search vs-search">
            <IconSearch size={15} />
            <input
              type="search"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="Search a name, number or purpose…"
              aria-label="Search follow-ups"
            />
          </div>
          <OwnerSelect value={ownerId} onChange={setOwnerId} placeholder="Any owner" />
          {window && (
            <span className="fu-active">
              {cards.find((card) => card.key === window)?.label}
              <button aria-label="Remove window filter" onClick={() => setWindow('')}>×</button>
            </span>
          )}
          {filtered && (
            <button
              className="filter-reset"
              onClick={() => {
                setQ('')
                setWindow('')
                setOwnerId('')
              }}
            >
              Clear all
            </button>
          )}
          </div>
        </div>

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
                      <th>Due</th>
                      <th>Contact</th>
                      <th>Purpose</th>
                      <th>Owner</th>
                      <th>Status</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((row) => (
                      <tr key={row.id} className={row.status === 'pending' && row.is_overdue ? 'fu-row-late' : undefined}>
                        <td className="crm-nowrap">
                          <Due iso={row.due_at} overdue={row.status === 'pending' && row.is_overdue} />
                        </td>
                        <td>
                          <div className="vs-who">
                            <span className="vs-avatar" aria-hidden>{initials(row.subject_name)}</span>
                            <span className="vs-who-text">
                              <span className="crm-strong">{row.subject_name ?? '—'}</span>
                              <span className="crm-sub">
                                <span className={`fu-kind is-${row.subject_kind === 'customer' ? 'customer' : 'lead'}`}>
                                  {row.subject_kind === 'customer' ? 'Customer' : 'Lead'}
                                </span>
                                {row.subject_mobile ? ` ${row.subject_mobile}` : ''}
                              </span>
                            </span>
                          </div>
                        </td>
                        <td className="fu-purpose">
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
              <div className="crm-foot">
                <span>
                  Showing {list.length} follow-up{list.length === 1 ? '' : 's'}
                </span>
              </div>
            </>
          )}
        </div>
      </section>

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
