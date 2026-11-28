import { useState, type FormEvent } from 'react'
import '../../../styles/leavedesk.css'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { useAuth } from '../../../lib/auth'
import { todayISO } from '../../../lib/format'
import { ErrorNote } from '../../../components/ui'
import { IconAlert, IconCheck, IconClock } from '../../../components/Icons'
import { Dialog } from '../../crm/parts'
import { errorText } from './MyLeave'

/* Apply for leave, as a popup. Shared by HRMS > Leave (applying for anybody in view) and My leave (applying for oneself):
   an employee sees only themselves in the Employee box. */

const days = (milli: number) => {
  const d = milli / 1000
  return `${Number.isInteger(d) ? d : d.toFixed(1)} day${d === 1 ? '' : 's'}`
}

interface Person { id: string; name: string; code: string | null }
interface LeaveType { id: string; name: string; allow_half_day: boolean; is_active: boolean }
interface Preview { duration_milli_days: number; available_milli_days: number; pending_milli_days: number; used_milli_days: number }

export default function ApplyDialog({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const { user } = useAuth()
  const people = useQuery<Person[]>('leave-desk-people', () => api.get<Person[]>('/leave/people'))
  const types = useQuery<LeaveType[]>('leave-desk-types', () => api.get<LeaveType[]>('/leave/types'))
  const today = todayISO()
  const [who, setWho] = useState(user?.id ?? '')
  const [typeId, setTypeId] = useState('')
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(today)
  const [half, setHalf] = useState(false)
  const [session, setSession] = useState('first_half')
  const [reason, setReason] = useState('')
  const [contact, setContact] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeTypes = (types.data ?? []).filter((t) => t.is_active)
  const type = activeTypes.find((t) => t.id === typeId) ?? activeTypes[0]
  const typeKey = type?.id ?? ''
  const end = half ? from : to < from ? from : to
  const preview = useQuery<Preview>(`leave-preview:${who}:${typeKey}:${from}:${end}:${half}`,
    () => api.get<Preview>(`/leave/preview?user_id=${who}&leave_type_id=${typeKey}&start=${from}&end=${end}&half=${half}`),
    { enabled: Boolean(who && typeKey) })

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!reason.trim()) { setError('Say why — the approver reads it.'); return }
    if (contactBad) { setError('The contact number must be 10 digits.'); return }
    setBusy(true); setError(null)
    try {
      await api.post(`/leave/applications${who && who !== user?.id ? `?user_id=${who}` : ''}`, {
        leave_type_id: typeKey, start_date: from, end_date: end, is_half_day: half,
        half_day_session: half ? session : null, reason: reason.trim(), contact_phone: contact.trim() || null,
      })
      onDone('Leave applied. It goes to the reporting manager first.')
    } catch (err) {
      setError(errorText(err))
    } finally { setBusy(false) }
  }

  const p = preview.data
  // Not enough left for this range: say so here, beside the numbers, instead of letting Apply fail afterwards.
  const short = p ? Math.max(0, p.duration_milli_days - p.available_milli_days) : 0
  const noWorkingDays = Boolean(p) && p!.duration_milli_days <= 0
  const noBalance = Boolean(p) && !noWorkingDays && short > 0
  const blocked = noBalance || noWorkingDays
  // Optional, but a partly typed number is not a number: it must be exactly 10 digits.
  const contactBad = contact.length > 0 && contact.length !== 10
  return (
    <Dialog title="Apply for leave" subtitle="Goes to the reporting manager first, then HR" onClose={onClose} medium
            footer={<><button className="btn" type="button" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" form="ld-apply" disabled={busy || !typeKey || !who || blocked || contactBad}>{busy ? 'Applying…' : 'Apply'}</button></>}>
      <form id="ld-apply" className="ld-form" onSubmit={submit}>
        <div className="ld-section">WHO, AND WHAT KIND</div>
        <div className="ld-two">
          <label><span className="ld-lbl">Employee <i className="lf-req">*</i></span>
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              {(people.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}{x.code ? ` (${x.code})` : ''}</option>)}
            </select></label>
          <label><span className="ld-lbl">Leave type <i className="lf-req">*</i></span>
            <select value={typeKey} onChange={(e) => { setTypeId(e.target.value); if (!activeTypes.find((t) => t.id === e.target.value)?.allow_half_day) setHalf(false) }}>
              {activeTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select></label>
        </div>
        <div className="ld-section">WHEN</div>
        <div className="ld-two">
          <label><span className="ld-lbl">From <i className="lf-req">*</i></span><input type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value) }} /></label>
          <label><span className="ld-lbl">To <i className="lf-req">*</i>{half && <span className="muted-sm"> Locked — a half day is one date</span>}</span>
            <input type="date" value={end} min={from} disabled={half} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        <div className="ld-half">
          <label className="crm-check"><input type="checkbox" checked={half} disabled={!type?.allow_half_day} onChange={(e) => setHalf(e.target.checked)} /> <IconClock size={14} /> Half day only</label>
          {half && <select value={session} onChange={(e) => setSession(e.target.value)}><option value="first_half">First half</option><option value="second_half">Second half</option></select>}
        </div>
        <div className={`ld-summary${blocked ? ' is-short' : ''}`}>
          <b>{blocked ? <IconAlert size={15} /> : <IconCheck size={15} />} {p ? (p.duration_milli_days === 500 ? 'half a day' : days(p.duration_milli_days)) : '…'}</b>
          {noWorkingDays && <div className="ld-short">That date is a weekly-off or a holiday for this person, so there is nothing to apply for. Pick a working day.</div>}
          {noBalance && <div className="ld-short">Not enough balance: this needs {days(p!.duration_milli_days)} and {type?.name ?? 'this leave'} has {days(Math.max(0, p!.available_milli_days))} available. Pick another type or another range, or ask HR to add to the balance.</div>}
          <div className="ld-summary-grid">
            <span><b>{p ? days(p.available_milli_days).replace(/ days?$/, '') : '—'}</b>Available</span>
            <span><b>{p ? days(p.pending_milli_days).replace(/ days?$/, '') : '—'}</b>Awaiting approval</span>
            <span><b>{p ? days(p.used_milli_days).replace(/ days?$/, '') : '—'}</b>Taken this year</span>
          </div>
        </div>
        <div className="ld-section">WHY</div>
        <div className="ld-two">
          <label><span className="ld-lbl">Reason <i className="lf-req">*</i> <span className="muted-sm">This is what the approver reads</span></span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Family function out of town" /></label>
          <label><span className="ld-lbl">Contact while away <span className="muted-sm">Optional — somebody always asks</span></span>
            <input value={contact} inputMode="numeric" maxLength={10} onChange={(e) => setContact(e.target.value.replace(/\D/g, '').slice(0, 10))}
                   aria-invalid={contactBad} placeholder="10-digit mobile number" />
            {contactBad && <span className="ld-bad">Enter all 10 digits, or leave it empty.</span>}</label>
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
      </form>
    </Dialog>
  )
}
