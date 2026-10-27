/* One lead, on a page of its own — opened from the pencil on My Leads.
 *
 * Two columns. The left is the record: every field the lead carries, the
 * follow-ups booked against it (done or cancelled from the row), and the
 * timeline of everything said and changed. The right is what somebody does
 * next: move the stage with a remark, and book the next follow-up. Those two
 * sit beside the record rather than in dialogs because they are the two
 * actions taken on nearly every visit to a lead.
 *
 * Fields are this product's own — a lead has no priority or district here, so
 * the page does not invent them.
 */

import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import '../../styles/crm.css'
import '../../styles/masterhub.css'
import { useQuery } from '../../lib/useQuery'
import { dateTime, relativeTime } from '../../lib/format'
import { ErrorNote, Loading } from '../../components/ui'
import {
  IconArrowLeft,
  IconBuilding,
  IconCalendar,
  IconCheck,
  IconClock,
  IconEdit,
  IconGlobe,
  IconMail,
  IconPhone,
  IconPin,
  IconSheet,
  IconStar,
  IconTrash,
  IconUsers,
} from '../../components/Icons'
import { crm, crmError, localToISO, type FollowUp, type LeadDetail as Detail } from './api'
import { Assignee, MasterSelect, OwnerSelect, StagePill, WhatsAppButton } from './parts'
import { ConvertDialog, LeadForm } from './MyLeads'

export default function LeadDetail() {
  const { leadId = '' } = useParams()
  const detail = useQuery<Detail>(`crm-lead-${leadId}`, () => crm.lead(leadId))
  const [editing, setEditing] = useState(false)
  const [converting, setConverting] = useState(false)
  const lead = detail.data

  if (detail.error) {
    return (
      <div className="crm">
        <BackLink />
        <ErrorNote>{crmError(detail.cause, 'This lead could not be loaded')}</ErrorNote>
      </div>
    )
  }
  if (!lead) return <div className="crm"><Loading label="Opening the lead…" /></div>

  const open = lead.follow_ups.filter((f) => f.status === 'pending').length

  return (
    <div className="crm ldp">
      <header className="ldp-head">
        <div className="ldp-head-main">
          <BackLink />
          <div className="ldp-head-text">
            <div className="ldp-title-row">
              <h1 className="ldp-title">{lead.name}</h1>
              <span className="crm-lead-code ldp-code">#{lead.code}</span>
              <StagePill name={lead.status_name} colour={lead.status_colour} />
            </div>
            <p className="ldp-sub">Full history and activity for this lead</p>
          </div>
        </div>
        <div className="ldp-head-actions">
          <WhatsAppButton mobile={lead.whatsapp ?? lead.mobile} />
          {!lead.customer_id && (
            <button className="btn btn-primary" onClick={() => setConverting(true)}>Convert to customer</button>
          )}
        </div>
      </header>

      {lead.customer_id && (
        <div className="notice notice-ok ldp-notice">
          Converted {lead.converted_at ? relativeTime(lead.converted_at) : ''} — this lead is now a customer.
        </div>
      )}
      {lead.lost_reason && <div className="notice notice-warn ldp-notice">Lost: {lead.lost_reason}</div>}

      <div className="ldp-grid">
        <div className="ldp-main">
          <section className="card ldp-card">
            <CardHead dot title="Lead Information"
                      action={<button className="btn btn-sm" onClick={() => setEditing(true)}><IconEdit size={14} /> Edit Lead</button>} />
            <div className="ldp-facts">
              <Fact icon={<IconPhone size={14} />} label="Mobile" value={lead.mobile} mono />
              <Fact icon={<IconPhone size={14} />} label="WhatsApp" value={lead.whatsapp ?? lead.mobile} mono />
              <Fact icon={<IconMail size={14} />} label="Email" value={lead.email} />
              <Fact icon={<IconGlobe size={14} />} label="Lead Source" value={lead.source_name} />
              <Fact icon={<IconUsers size={14} />} label="Lead Owner" value={lead.owner_name && <Assignee name={lead.owner_name} />} />
              <Fact icon={<IconBuilding size={14} />} label="Company" value={lead.company} />
              <Fact label="Industry" value={lead.industry_name} />
              <Fact label="Product / Service" value={lead.product_name} />
              <Fact label="Deal value" value={lead.value && `₹${Number(lead.value).toLocaleString('en-IN')}`} />
              <Fact icon={<IconPin size={14} />} label="State" value={lead.state_name} />
              <Fact label="City" value={lead.city_name} />
              <Fact label="Pincode" value={lead.pincode} />
              <Fact label="Address" value={lead.address} wide />
              {lead.notes && <Fact label="Notes" value={lead.notes} wide />}
              <Fact label="Created" value={dateTime(lead.created_at)} />
              <Fact label="Last contacted" value={lead.last_contacted_at && relativeTime(lead.last_contacted_at)} />
            </div>
          </section>

          <FollowUpHistory rows={lead.follow_ups} onChanged={detail.reload} />

          <Timeline lead={lead} onChanged={detail.reload} />
        </div>

        <aside className="ldp-side">
          <StatusUpdate lead={lead} onSaved={detail.reload} />
          <NextFollowUp leadId={lead.id} open={open} onSaved={detail.reload} />
          {lead.quotations.length > 0 && (
            <section className="card ldp-card">
              <CardHead icon={<IconSheet size={16} />} title="Quotations" />
              <ul className="ldp-list">
                {lead.quotations.map((q) => (
                  <li key={q.id}>
                    <Link to={`/crm/quotations/${q.id}`}>{q.number ?? 'Draft'}</Link>
                    <span className="crm-sub">{q.status}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>

      {editing && (
        <LeadForm
          lead={lead}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            detail.reload()
          }}
        />
      )}
      {converting && (
        <ConvertDialog
          lead={lead}
          onClose={() => setConverting(false)}
          onDone={() => {
            setConverting(false)
            detail.reload()
          }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------- pieces --- */

function BackLink() {
  return (
    <Link to="/crm/leads" className="master-back ldp-back" aria-label="Back to My Leads" title="Back to My Leads">
      <IconArrowLeft size={18} />
    </Link>
  )
}

function CardHead({ title, icon, dot, action, badge }: {
  title: string
  icon?: ReactNode
  dot?: boolean
  action?: ReactNode
  badge?: ReactNode
}) {
  return (
    <div className="ldp-card-head">
      {dot && <span className="ldp-dot" aria-hidden />}
      {icon && <span className="ldp-card-icon" aria-hidden>{icon}</span>}
      <h2 className="ldp-card-title">{title}</h2>
      {badge}
      {action && <div className="ldp-card-action">{action}</div>}
    </div>
  )
}

function Fact({ icon, label, value, wide, mono }: {
  icon?: ReactNode
  label: string
  value: ReactNode
  wide?: boolean
  mono?: boolean
}) {
  return (
    <div className={`ldp-fact${wide ? ' is-wide' : ''}`}>
      <span className="ldp-fact-label">{icon}{label}</span>
      <span className={`ldp-fact-value${mono ? ' crm-mono' : ''}`}>
        {value || value === 0 ? value : <span className="crm-muted">—</span>}
      </span>
    </div>
  )
}

const FOLLOW_STATE: Record<string, { label: string; tone: string }> = {
  pending: { label: 'Pending', tone: 'warn' },
  done: { label: 'Done', tone: 'good' },
  cancelled: { label: 'Cancelled', tone: 'idle' },
}

function FollowUpHistory({ rows, onChanged }: { rows: FollowUp[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function act(id: string, run: () => Promise<unknown>, failure: string) {
    setBusy(id)
    setError(null)
    try {
      await run()
      onChanged()
    } catch (err) {
      setError(crmError(err, failure))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="card ldp-card">
      <CardHead icon={<IconClock size={16} />} title="Follow-Up History" />
      {error && <div className="ldp-pad"><ErrorNote>{error}</ErrorNote></div>}
      {rows.length === 0 ? (
        <p className="ldp-empty">No follow-ups yet. Book the next one from the panel on the right.</p>
      ) : (
        <div className="table-wrap">
          <table className="ldp-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Time</th>
                <th>Purpose</th>
                <th>Remarks</th>
                <th>Assigned to</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => {
                const when = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(f.due_at) ? f.due_at : `${f.due_at}Z`)
                const state = f.status === 'pending' && f.is_overdue
                  ? { label: 'Overdue', tone: 'bad' }
                  : FOLLOW_STATE[f.status] ?? { label: f.status, tone: 'idle' }
                return (
                  <tr key={f.id}>
                    <td className="crm-nowrap">{when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                    <td className="crm-nowrap">{when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</td>
                    <td>{f.purpose ?? <span className="crm-muted">Follow-up</span>}</td>
                    <td className="ldp-remarks">{f.outcome ?? f.notes ?? <span className="crm-muted">—</span>}</td>
                    <td><Assignee name={f.owner_name} /></td>
                    <td><span className={`crm-state crm-state-${state.tone}`}>{state.label}</span></td>
                    <td>
                      <div className="crm-row-actions">
                        {f.status === 'pending' && (
                          <>
                            <button className="crm-icon-btn ldp-done" disabled={busy === f.id} title="Mark done"
                                    aria-label="Mark this follow-up done"
                                    onClick={() => void act(f.id, () => crm.completeFollowUp(f.id, {}), 'That follow-up could not be closed')}>
                              <IconCheck size={15} />
                            </button>
                            <button className="crm-icon-btn ldp-cancel" disabled={busy === f.id} title="Cancel"
                                    aria-label="Cancel this follow-up"
                                    onClick={() => {
                                      if (window.confirm('Cancel this follow-up?')) {
                                        void act(f.id, () => crm.cancelFollowUp(f.id), 'That follow-up could not be cancelled')
                                      }
                                    }}>
                              <IconTrash size={15} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Timeline({ lead, onChanged }: { lead: Detail; onChanged: () => void }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add() {
    if (!note.trim()) return
    setBusy(true)
    setError(null)
    try {
      await crm.addActivity(lead.id, { body: note.trim(), kind: 'note' })
      setNote('')
      onChanged()
    } catch (err) {
      setError(crmError(err, 'That note could not be saved'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card ldp-card">
      <CardHead icon={<IconStar size={16} />} title="Activity" />
      <div className="ldp-pad">
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="ldp-note">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                    placeholder="Add a note — what was said, what was agreed…" />
          <button className="btn btn-sm" disabled={busy || !note.trim()} onClick={() => void add()}>
            {busy ? 'Saving…' : 'Add note'}
          </button>
        </div>
        <div className="crm-timeline">
          {lead.activities.length === 0 && <p className="ldp-empty">Nothing recorded yet.</p>}
          {lead.activities.map((event) => (
            <div className={`crm-event crm-event-${event.kind}`} key={event.id}>
              <span className="crm-event-dot" />
              <div>
                <div className="crm-event-body">{event.body}</div>
                <div className="crm-event-when">{event.actor_name ?? 'System'} · {relativeTime(event.created_at)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function StatusUpdate({ lead, onSaved }: { lead: Detail; onSaved: () => void }) {
  const [statusId, setStatusId] = useState(lead.status_id ?? '')
  const [remark, setRemark] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const changed = statusId !== (lead.status_id ?? '')

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await crm.moveLead(lead.id, { status_id: statusId, note: remark.trim() || null })
      setRemark('')
      setDone(true)
      onSaved()
    } catch (err) {
      setError(crmError(err, 'The status could not be changed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card ldp-card">
      <CardHead icon={<IconStar size={16} />} title="Lead Status Update" />
      <div className="ldp-form">
        {error && <ErrorNote>{error}</ErrorNote>}
        <label className="ldp-field">
          <span>Lead status</span>
          <MasterSelect kind="statuses" value={statusId} onChange={(v) => { setStatusId(v); setDone(false) }} />
        </label>
        <label className="ldp-field">
          <span>Remarks</span>
          <textarea value={remark} onChange={(e) => setRemark(e.target.value)} rows={3} maxLength={300}
                    placeholder="Add a remark for this status change…" />
        </label>
        <button className="btn btn-primary ldp-submit" disabled={busy || !changed} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save Status'}
        </button>
        {done && !changed && <span className="ldp-ok">Status saved.</span>}
        {!changed && !done && <span className="ldp-hint">Pick a different status to save.</span>}
      </div>
    </section>
  )
}

function NextFollowUp({ leadId, open, onSaved }: { leadId: string; open: number; onSaved: () => void }) {
  const [date, setDate] = useState('')
  const [time, setTime] = useState('10:00')
  const [purpose, setPurpose] = useState('')
  const [notes, setNotes] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await crm.createFollowUp({
        lead_id: leadId,
        due_at: localToISO(`${date}T${time || '10:00'}`),
        purpose: purpose.trim() || null,
        notes: notes.trim() || null,
        owner_id: ownerId || null,
      })
      setDate('')
      setPurpose('')
      setNotes('')
      setDone(true)
      onSaved()
    } catch (err) {
      setError(crmError(err, 'That follow-up could not be booked'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card ldp-card">
      <CardHead icon={<IconCalendar size={16} />} title="Next Follow-Up"
                badge={open > 0 ? <span className="ldp-badge">{open} open</span> : undefined} />
      <div className="ldp-form">
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="ldp-two">
          <label className="ldp-field">
            <span>Date</span>
            <input type="date" value={date} onChange={(e) => { setDate(e.target.value); setDone(false) }} />
          </label>
          <label className="ldp-field">
            <span>Time</span>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        </div>
        <label className="ldp-field">
          <span>Purpose</span>
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={300}
                 placeholder="Call, send pricing, confirm the demo…" />
        </label>
        <label className="ldp-field">
          <span>Remarks</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
                    placeholder="What's the plan for this follow-up?" />
        </label>
        <label className="ldp-field">
          <span>Assign to</span>
          <OwnerSelect value={ownerId} onChange={setOwnerId} placeholder="Whoever owns the lead" />
        </label>
        <button className="btn btn-primary ldp-submit" disabled={busy || !date} onClick={() => void save()}>
          {busy ? 'Booking…' : 'Book Follow-Up'}
        </button>
        {done && <span className="ldp-ok">Follow-up booked.</span>}
      </div>
    </section>
  )
}
