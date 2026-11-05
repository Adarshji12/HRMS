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
import { download } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { dateTime, relativeTime } from '../../lib/format'
import { ErrorNote, Loading } from '../../components/ui'
import {
  IconArrowLeft,
  IconBriefcase,
  IconCalendar,
  IconCheck,
  IconClock,
  IconEdit,
  IconPlus,
  IconSheet,
  IconStar,
  IconTrash,
} from '../../components/Icons'
import { crm, crmError, localToISO, type FollowUp, type LeadDetail as Detail, type Opportunity } from './api'
import { Assignee, MasterSelect, OwnerSelect, StagePill, WhatsAppButton } from './parts'
import { ConvertDialog, LeadForm } from './MyLeads'
import { OpportunityForm } from './OpportunityForm'

export default function LeadDetail() {
  const { leadId = '' } = useParams()
  const detail = useQuery<Detail>(`crm-lead-${leadId}`, () => crm.lead(leadId))
  const [editing, setEditing] = useState(false)
  const [converting, setConverting] = useState(false)
  const opportunities = useQuery<Opportunity[]>(
    `crm-lead-opportunities-${leadId}`,
    () => crm.opportunities(leadId),
  )
  // An opportunity being edited, 'new' for a blank form, null for none.
  const [opportunityOpen, setOpportunityOpen] = useState<Opportunity | 'new' | null>(null)
  const lead = detail.data
  const deals = opportunities.data ?? []

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
          </div>
        </div>
        <div className="ldp-head-actions">
          <WhatsAppButton mobile={lead.whatsapp ?? lead.mobile} />
          <Link className="btn" to={`/crm/quotations/new?lead=${lead.id}`}>
            <IconSheet size={14} /> Add quotation
          </Link>
          {!lead.customer_id && (
            <button className="btn btn-primary" disabled={editing} title={editing ? busyEditing : undefined} onClick={() => setConverting(true)}>Convert to customer</button>
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
          {editing ? (
            <section className="card ldp-card ldp-card-edit">
              <CardHead dot title="Edit Lead Information" />
              {deals.length > 1 && (
                <p className="ldp-edit-note">
                  This lead has {deals.length} deals. Edit them from Opportunities once this is saved.
                </p>
              )}
              <LeadForm
                inline
                lead={lead}
                opportunity={!opportunities.data || deals.length > 1 ? undefined : deals[0] ?? null}
                onClose={() => setEditing(false)}
                onSaved={() => {
                  setEditing(false)
                  detail.reload()
                  opportunities.reload()
                }}
              />
            </section>
          ) : (
          <section className="card ldp-card">
            <CardHead dot title="Lead Information"
                      action={<button className="btn btn-sm" disabled={opportunities.loading} onClick={() => setEditing(true)}><IconEdit size={14} /> Edit Lead</button>} />
            <div className="ldp-facts">
              <Fact label="Mobile" value={lead.mobile} mono />
              <Fact label="WhatsApp" value={lead.whatsapp ?? lead.mobile} mono />
              <Fact label="Email" value={lead.email} />
              <Fact label="Company" value={lead.company} />
              <Fact label="Lead Source" value={lead.source_name} />
              <Fact label="Lead Owner" value={lead.owner_name && <Assignee name={lead.owner_name} />} />
              <Fact label="Industry" value={lead.industry_name} />
              <Fact label="Product / Service" value={lead.product_name} />
              <Fact label="Expected revenue" value={lead.value && `₹${Number(lead.value).toLocaleString('en-IN')}`} />
              <Fact label="State" value={lead.state_name} />
              <Fact label="City" value={lead.city_name} />
              <Fact label="Pincode" value={lead.pincode} />
              <Fact label="Created" value={dateTime(lead.created_at)} />
              <Fact label="Last contacted" value={lead.last_contacted_at && relativeTime(lead.last_contacted_at)} />
              <Fact label="Address" value={lead.address} span2 />
              {lead.notes && <Fact label="Notes" value={lead.notes} wide />}
            </div>
            <DealFacts deals={deals} />
          </section>
          )}

          <FollowUpHistory rows={lead.follow_ups} onChanged={detail.reload} />

          <Timeline lead={lead} onChanged={detail.reload} />
        </div>

        <aside className="ldp-side">
          <StatusUpdate lead={lead} onSaved={detail.reload} />
          <NextFollowUp leadId={lead.id} open={open} onSaved={detail.reload} />
          <section className="card ldp-card">
            <CardHead icon={<IconBriefcase size={16} />} title="Opportunities"
                      action={<button className="btn btn-sm" type="button" disabled={editing} title={editing ? busyEditing : undefined} onClick={() => setOpportunityOpen('new')}><IconPlus size={14} /> Add</button>} />
            {(opportunities.data ?? []).length === 0 ? (
              <p className="crm-sub ldp-empty-note">No opportunity yet.</p>
            ) : (
              <ul className="ldp-list">
                {(opportunities.data ?? []).map((o) => (
                  <li key={o.id}>
                    <button type="button" className="ldp-link" disabled={editing} title={editing ? busyEditing : undefined} onClick={() => setOpportunityOpen(o)}>{o.title}</button>
                    <span className="crm-sub">
                      ₹{Number(o.expected_revenue).toLocaleString('en-IN')} · {o.probability}%
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card ldp-card">
            <CardHead icon={<IconSheet size={16} />} title="Quotations"
                      action={<Link className="btn btn-sm" to={`/crm/quotations/new?lead=${lead.id}`}><IconPlus size={14} /> Add</Link>} />
            {lead.quotations.length === 0 ? (
              <p className="crm-sub ldp-empty-note">No quotation yet.</p>
            ) : (
              <ul className="ldp-list">
                {lead.quotations.map((q) => (
                  <li key={q.id}>
                    <Link to={`/crm/quotations/${q.id}`}>{q.number ?? 'Draft'}</Link>
                    <span className="crm-sub">{q.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>

      {opportunityOpen && (
        <OpportunityForm
          lead={lead}
          opportunity={opportunityOpen === 'new' ? null : opportunityOpen}
          onClose={() => setOpportunityOpen(null)}
          onSaved={() => {
            setOpportunityOpen(null)
            opportunities.reload()
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

// The open form holds its own copy of the deal, so changing it elsewhere first
// would be overwritten when the form saves.
const busyEditing = 'Save or cancel the lead edit first'

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

function Fact({ label, value, wide, span2, mono }: {
  label: string
  value: ReactNode
  wide?: boolean
  span2?: boolean
  mono?: boolean
}) {
  return (
    <div className={`ldp-fact${wide ? ' is-wide' : ''}${span2 ? ' is-span2' : ''}`}>
      <span className="ldp-fact-label">{label}</span>
      <span className={`ldp-fact-value${mono ? ' crm-mono' : ''}`}>
        {value || value === 0 ? value : <span className="crm-muted">—</span>}
      </span>
    </div>
  )
}

// A date with no time: read as local, so it cannot slip a day.
const closingDate = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

const rupees = (value: string | null) =>
  value === null ? null : `₹${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

const COSTSHEET_STATE: Record<Opportunity['costsheet_status'], string | null> = {
  none: null,
  pending: 'Pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
}

function DealFile({ deal, which }: { deal: Opportunity; which: 'costsheet' | 'quotation' }) {
  const file = deal[which]
  if (!file) return null
  return (
    <button type="button" className="ldp-link"
            onClick={() => void download(`/crm/opportunities/${deal.id}/files/${which}`, file.name)}>
      {file.name}
    </button>
  )
}

/** The deal details saved with the lead. They live on the lead's opportunities,
 *  so a lead with several shows one block each. With none, the same fields show
 *  empty, as the lead's own blank fields do. */
function DealFacts({ deals }: { deals: Opportunity[] }) {
  const rows: Array<Opportunity | null> = deals.length > 0 ? deals : [null]
  return (
    <>
      {rows.map((deal) => (
        <div className="ldp-deal" key={deal?.id ?? 'none'}>
          <div className="ldp-deal-head">
            <IconBriefcase size={15} />
            <h3>{deals.length > 1 && deal ? deal.title : 'Deal details'}</h3>
          </div>
          <div className="ldp-facts ldp-deal-facts">
            <Fact label="Deal value" value={deal && rupees(deal.expected_revenue)} />
            <Fact label="Probability" value={deal && `${deal.probability}%`} />
            <Fact label="Expected closing" value={deal?.expected_closing && closingDate(deal.expected_closing)} />
            <Fact label="Existing customer" value={deal?.customer_name} />
            <Fact label="Currency" value={deal && 'INR (₹)'} />
            <Fact label="Priority" value={deal && deal.priority > 0 && (
              <span className="ldp-stars" role="img" aria-label={`${deal.priority} of 3 stars`}>
                {[1, 2, 3].map((n) => <IconStar key={n} size={15} className={n <= deal.priority ? 'is-on' : undefined} />)}
              </span>
            )} />
            <Fact label="Tags" value={deal && deal.tags.length > 0 && (
              <span className="ldp-tags">{deal.tags.map((tag) => <span className="ldp-tag" key={tag}>{tag}</span>)}</span>
            )} />
            <Fact label="Requirement type" value={deal?.requirement_type_name} />
            <Fact label="OEM" value={deal?.oem_name} />
            <Fact label="Raw cost" value={deal && rupees(deal.raw_cost)} />
            <Fact label="Sales team" value={deal?.team_name} />
            <Fact label="Margin" value={deal && rupees(deal.margin)} />
            <Fact label="Margin %" value={deal?.margin_percent != null && `${Number(deal.margin_percent).toFixed(2)}%`} />
            <Fact label="Costsheet" value={deal?.costsheet && <DealFile deal={deal} which="costsheet" />} />
            <Fact label="Costsheet approval" value={deal && COSTSHEET_STATE[deal.costsheet_status]} />
            <Fact label="Quotation" value={deal?.quotation && <DealFile deal={deal} which="quotation" />} />
            <Fact label="Mail sent to the customer" value={deal && (deal.is_mail_send ? 'Yes' : 'No')} />
            <Fact label="Internal notes" value={deal?.notes} wide />
          </div>
        </div>
      ))}
    </>
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
          <textarea value={remark} onChange={(e) => setRemark(e.target.value)} rows={2} maxLength={300}
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
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
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
