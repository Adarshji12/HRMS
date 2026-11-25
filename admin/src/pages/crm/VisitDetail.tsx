/**
 * One visit, on its own page: who it is for, where it stands (scheduled →
 * started → completed), what was done there, and the next follow-up. Opened by
 * clicking the customer's name in My Visits.
 */

import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import '../../styles/crm.css'
import '../../styles/visits.css'
import { useQuery } from '../../lib/useQuery'
import { ErrorNote, Loading } from '../../components/ui'
import { IconArrowLeft, IconCheck, IconClose, IconEdit, IconPlus } from '../../components/Icons'
import { crm, crmError, isoToLocalInput, localToISO, type Visit } from './api'
import { CrmPage, Dialog, Field } from './parts'
import { CheckInDialog, CloseVisitDialog } from './MyVisits'

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')
const STATUS: Record<Visit['status'], string> = { scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' }

function onSite(v: Visit): string {
  if (!v.started_at) return '—'
  const end = v.completed_at ? new Date(v.completed_at).getTime() : Date.now()
  const mins = Math.max(0, Math.round((end - new Date(v.started_at).getTime()) / 60000))
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60
  return [d && `${d}d`, (d || h) && `${h}h`, !d && `${m}m`].filter(Boolean).join(' ')
}

export default function VisitDetail() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const list = useQuery<Visit[]>(`crm-visit-${id}`, () => crm.visits({}))
  const [dialog, setDialog] = useState<null | 'start' | 'complete' | 'move' | 'activity' | 'follow'>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const v = list.data?.find((x) => x.id === id)

  async function act(fn: () => Promise<unknown>, fail: string) {
    setBusy(true); setError(null)
    try { await fn(); list.reload() } catch (e) { setError(crmError(e, fail)) } finally { setBusy(false) }
  }

  if (!list.data) return <CrmPage><Loading /></CrmPage>
  if (!v) return <CrmPage><ErrorNote>That visit could not be found.</ErrorNote><Link to="/crm/visits">Back to visits</Link></CrmPage>

  const open = v.status === 'scheduled' || v.status === 'in_progress'
  const done = () => { setDialog(null); list.reload() }
  const subject = v.subject_kind === 'lead' ? (v.lead_id ? `/crm/leads/${v.lead_id}` : null) : (v.customer_id ? `/crm/customers?open=${v.customer_id}` : null)

  return (
    <CrmPage>
      <div className="vd">
        <section className="card vd-head">
          <button type="button" className="crm-icon-btn" aria-label="Back to visits" onClick={() => nav('/crm/visits')}><IconArrowLeft size={16} /></button>
          <span className="vs-avatar vd-avatar" aria-hidden>{(v.customer_name ?? '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}</span>
          <div className="vd-title">
            <h1>{v.customer_name ?? 'Visit'} <span className={`vd-pill is-${v.status}`}>{STATUS[v.status]}</span> <span className="vd-pill">{v.priority}</span></h1>
            <p className="muted-sm">{v.visit_no}{v.visit_type_name ? ` · ${v.visit_type_name}` : ''} · {when(v.scheduled_at)}</p>
          </div>
          <div className="vd-actions">
            {v.status === 'scheduled' && <button className="btn btn-primary" disabled={busy} onClick={() => (v.otp_required ? setDialog('start') : void act(() => crm.startVisit(v.id, {}), 'The visit could not be started'))}>Start visit</button>}
            {v.status === 'in_progress' && <button className="btn btn-primary" onClick={() => setDialog('complete')}><IconCheck size={14} /> Complete Visit</button>}
            {open && <button className="btn" onClick={() => setDialog('move')}>Reschedule</button>}
            {open && <button className="btn" disabled={busy} onClick={() => { if (window.confirm('Cancel this visit?')) void act(() => crm.cancelVisit(v.id), 'The visit could not be cancelled') }}><IconClose size={13} /> Cancel</button>}
          </div>
        </section>
        {error && <ErrorNote>{error}</ErrorNote>}

        <section className="card vd-steps">
          {([
            { label: 'Scheduled', main: when(v.scheduled_at), sub: `Booked ${new Date(v.created_at).toLocaleDateString('en-IN')}`, done: true },
            { label: 'Started', main: v.started_at ? when(v.started_at) : 'Not yet', sub: v.started_at ? (v.otp_required ? (v.otp_verified ? 'OTP verified' : 'OTP required') : 'No OTP required') : 'Waiting for check-in', done: Boolean(v.started_at) },
            { label: 'Completed', main: v.completed_at ? when(v.completed_at) : 'Not yet', sub: v.completed_at ? 'Closed' : 'While the visit is open', done: v.status === 'completed' },
          ]).map((st, n, all) => {
            const state = st.done ? 'done' : all.slice(0, n).every((x) => x.done) ? 'now' : 'next'
            return (
              <div key={st.label} className={`vd-step is-${state}`}>
                <div className="vd-mark">
                  <i aria-hidden>{state === 'done' ? <IconCheck size={11} /> : state === 'now' ? <b /> : null}</i>
                  {n < all.length - 1 && <u className={all[n + 1].done || (state === 'done') ? 'is-on' : ''} />}
                </div>
                <b>{st.label}</b><strong>{st.main}</strong><small>{st.sub}</small>
              </div>
            )
          })}
          <div className="vd-site"><b>Time on site</b><strong>{onSite(v)}</strong><small>{v.completed_at ? 'Final' : v.started_at ? 'Still open' : '—'}</small></div>
        </section>

        <div className="vd-cols">
          <section className="card vd-card">
            <header><h3>Visit Activity</h3>
              <button className="btn btn-sm" onClick={() => setDialog('activity')}><IconEdit size={14} /> Edit activity</button></header>
            {v.outcome ? <p className="vd-text">{v.outcome}</p> : (
              <div className="vd-empty"><b>Nothing written up yet</b><span>Use Edit activity to record what happened, or write it up when completing the visit.</span></div>
            )}
            {v.purpose && <p className="muted-sm">Purpose: {v.purpose}</p>}
          </section>
          <aside className="vd-side">
            <section className="card vd-card">
              <header><h3>{v.subject_kind === 'lead' ? 'Lead' : 'Customer'}</h3>{subject && <Link to={subject}>Open ↗</Link>}</header>
              <dl className="vd-facts">
                <dt>Customer</dt><dd>{v.customer_name ?? '—'}{v.contact_person && <small>Contact: {v.contact_person}</small>}</dd>
                <dt>Mobile</dt><dd>{v.mobile ?? v.customer_mobile ?? '—'}</dd>
                {v.address && <><dt>Address</dt><dd>{v.address}</dd></>}
                <dt>Assigned to</dt><dd>{v.employee_name ?? '—'}</dd>
              </dl>
            </section>
            <section className="card vd-card">
              <header><h3>Next Follow-up</h3><button className="btn btn-sm" onClick={() => setDialog('follow')}><IconPlus size={13} /> Book</button></header>
              <p className="muted-sm">Book a follow-up and it appears in My Follow-ups.</p>
            </section>
          </aside>
        </div>
      </div>

      {dialog === 'start' && <CheckInDialog visit={v} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'complete' && <CloseVisitDialog visit={v} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'move' && <MoveDialog visit={v} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'activity' && <ActivityDialog visit={v} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'follow' && <FollowDialog visit={v} onClose={() => setDialog(null)} onDone={done} />}
    </CrmPage>
  )
}

type DialogProps = { visit: Visit; onClose: () => void; onDone: () => void }

function useSave(onDone: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function save(fn: () => Promise<unknown>, fail: string) {
    setBusy(true); setError(null)
    try { await fn(); onDone() } catch (e) { setError(crmError(e, fail)); setBusy(false) }
  }
  return { busy, error, save }
}

function MoveDialog({ visit, onClose, onDone }: DialogProps) {
  const start = isoToLocalInput(visit.scheduled_at)
  const [date, setDate] = useState(start.slice(0, 10))
  const [time, setTime] = useState(start.slice(11, 16))
  const [reason, setReason] = useState('')
  const { busy, error, save } = useSave(onDone)
  return (
    <Dialog title="Reschedule Visit" subtitle="The old date is kept in the visit's notes, so a customer who keeps moving is visible." onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !date} onClick={() => void save(() => crm.patchVisit(visit.id, {
          scheduled_at: localToISO(`${date}T${time || '10:00'}`),
          notes: [visit.notes, `Moved from ${when(visit.scheduled_at)}${reason ? ` — ${reason}` : ''}`].filter(Boolean).join('\n'),
        }), 'The visit could not be moved')}>Reschedule</button></>}>
      <div className="crm-form" style={{ padding: '4px 26px 8px' }}>
        {error && <div className="crm-form-wide"><ErrorNote>{error}</ErrorNote></div>}
        <Field label="New date" required><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Time"><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
        <Field label="Reason" wide><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it moved" /></Field>
      </div>
    </Dialog>
  )
}

function ActivityDialog({ visit, onClose, onDone }: DialogProps) {
  const [text, setText] = useState(visit.outcome ?? '')
  const { busy, error, save } = useSave(onDone)
  return (
    <Dialog title="Edit Visit Activity" subtitle="What happened at the customer's place." onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => void save(() => crm.patchVisit(visit.id, { outcome: text.trim() }), 'The activity could not be saved')}>Save activity</button></>}>
      <div className="crm-form" style={{ padding: '4px 26px 8px' }}>
        {error && <div className="crm-form-wide"><ErrorNote>{error}</ErrorNote></div>}
        <Field label="Work / Activity Details" required wide><textarea rows={5} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="What was actually done at the customer's place" /></Field>
      </div>
    </Dialog>
  )
}

function FollowDialog({ visit, onClose, onDone }: DialogProps) {
  const [date, setDate] = useState('')
  const [time, setTime] = useState('10:00')
  const [notes, setNotes] = useState('')
  const { busy, error, save } = useSave(onDone)
  return (
    <Dialog title="Create a Follow-up" subtitle={`It appears in My Follow-ups against ${visit.customer_name ?? 'this customer'}.`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !date} onClick={() => void save(() => crm.createFollowUp({
          due_at: localToISO(`${date}T${time || '10:00'}`), lead_id: visit.lead_id, customer_id: visit.customer_id,
          purpose: 'Visit', notes: notes || null,
        }), 'The follow-up could not be booked')}>Create Follow-up</button></>}>
      <div className="crm-form" style={{ padding: '4px 26px 8px' }}>
        {error && <div className="crm-form-wide"><ErrorNote>{error}</ErrorNote></div>}
        <Field label="Follow-up date" required><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Time"><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
        <Field label="Remarks" wide><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What has to happen next" /></Field>
      </div>
    </Dialog>
  )
}
