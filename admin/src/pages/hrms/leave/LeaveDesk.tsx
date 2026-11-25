/* HRMS → Leave: Requests, Balances and Calendar for the people the viewer sees.
 * An administrator sees the company, a manager their reporting line. */

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import '../../../styles/leavedesk.css'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { canAdminister, useAuth } from '../../../lib/auth'
import { todayISO } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import { IconCalendar, IconCheck, IconClose, IconClock, IconPlus, IconReturn } from '../../../components/Icons'
import { Dialog } from '../../crm/parts'
import { errorText } from './MyLeave'

type Tab = 'requests' | 'balances' | 'calendar'
type Status = 'pending' | 'approved' | 'rejected' | 'cancelled'

interface Item {
  id: string; user_id: string; name: string; code: string | null; leave_type: string; color: string | null
  start_date: string; end_date: string; is_half_day: boolean; half_day_session: string | null
  duration_milli_days: number; reason: string | null; contact_phone: string | null
  status: Status; applied_at: string; review_note: string | null; waiting_on_me: boolean
}
interface Requests { counts: Record<Status, number>; waiting_on_me: number; items: Item[] }

const days = (milli: number) => {
  const d = milli / 1000
  return `${Number.isInteger(d) ? d : d.toFixed(1)} day${d === 1 ? '' : 's'}`
}
const dmy = (iso: string) => iso.split('-').reverse().join('/')
const range = (a: string, b: string) => (a === b ? dmy(a) : `${dmy(a)} – ${dmy(b)}`)

export default function LeaveDesk() {
  const [params, setParams] = useSearchParams()
  const tab: Tab = (['requests', 'balances', 'calendar'] as const).find((t) => t === params.get('tab')) ?? 'requests'
  const [applying, setApplying] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  return (
    <div className="ld">
      <div className="ld-head">
        <div>
          <h1 className="page-title">Leave</h1>
          <p className="page-sub">Applications, balances and who is off when</p>
        </div>
        <div className="ld-head-right">
          <nav className="ld-tabs" role="tablist">
            {([['requests', 'Requests', <IconReturn size={15} key="a" />], ['balances', 'Balances', <IconClock size={15} key="b" />], ['calendar', 'Calendar', <IconCalendar size={15} key="c" />]] as const).map(([key, label, icon]) => (
              <button key={key} role="tab" aria-selected={tab === key} className={`ld-tab${tab === key ? ' is-on' : ''}`} onClick={() => setParams({ tab: key }, { replace: true })}>
                {icon} {label}
              </button>
            ))}
          </nav>
          {tab === 'requests' && <button type="button" className="btn btn-primary" onClick={() => setApplying(true)}><IconPlus size={15} /> Apply for Leave</button>}
        </div>
      </div>
      {tab === 'requests' ? <RequestsTab refresh={refresh} notice={notice} /> : tab === 'balances' ? <BalancesTab /> : <CalendarTab />}
      {applying && <ApplyDialog onClose={() => setApplying(false)} onDone={(m) => { setApplying(false); setNotice(m); setRefresh((n) => n + 1) }} />}
    </div>
  )
}

/* ------------------------------------------------------------- requests -- */

const TILES: Array<{ key: Status; label: string; icon: JSX.Element; tone: string }> = [
  { key: 'pending', label: 'Awaiting', icon: <IconClock size={20} />, tone: 'warn' },
  { key: 'approved', label: 'Approved', icon: <IconCheck size={20} />, tone: 'good' },
  { key: 'rejected', label: 'Rejected', icon: <IconClose size={20} />, tone: 'bad' },
  { key: 'cancelled', label: 'Cancelled', icon: <IconClose size={20} />, tone: 'muted' },
]

function RequestsTab({ refresh, notice: outer }: { refresh: number; notice: string | null }) {
  const [view, setView] = useState<Status | 'all'>('pending')
  const [mine, setMine] = useState(false)
  const [inner, setNotice] = useState<string | null>(null)
  const notice = inner ?? outer
  const q = useQuery<Requests>('leave-desk-requests', () => api.get<Requests>('/leave/requests'))
  useEffect(() => { if (refresh) void q.reload() }, [refresh]) // eslint-disable-line react-hooks/exhaustive-deps
  if (q.error) return <ErrorNote>{errorText(q.error)}</ErrorNote>
  if (!q.data) return <Loading />
  const data = q.data
  const rows = data.items.filter((i) => (view === 'all' || i.status === view) && (!mine || i.waiting_on_me))

  return (
    <>
      <div className="ld-tiles">
        {TILES.map((t) => (
          <button key={t.key} type="button" className={`ld-tile ld-${t.tone}${view === t.key ? ' is-on' : ''}`} onClick={() => setView(t.key)}>
            <span className="ld-tile-icon">{t.icon}</span>
            <span><b>{data.counts[t.key] ?? 0}</b><span>{t.label}</span></span>
          </button>
        ))}
      </div>

      <section className="card ld-card">
        <div className="ld-bar">
          <div className="ld-pills">
            {([['pending', 'Awaiting'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['cancelled', 'Cancelled'], ['all', 'All']] as const).map(([k, label]) => (
              <button key={k} type="button" className={`ld-pill${view === k ? ' is-on' : ''}`} onClick={() => setView(k)}>
                {label} <span className="ld-count">{k === 'all' ? data.items.length : (data.counts[k] ?? 0)}</span>
              </button>
            ))}
          </div>
          <div className="ld-bar-right">
            <button type="button" className={`btn ld-wait${mine ? ' is-on' : ''}`} onClick={() => setMine(!mine)}>
              <span className="ld-wait-dot" /> Waiting on me{data.waiting_on_me ? ` (${data.waiting_on_me})` : ''}
            </button>
          </div>
        </div>
        {notice && <div className="notice notice-ok" style={{ margin: 16 }}>{notice}</div>}
        {rows.length === 0 ? (
          <div className="ld-empty"><span className="ld-empty-icon"><IconReturn size={22} /></span><b>Nothing here</b><p>Leave applications land here for a decision.</p></div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Employee</th><th>Leave</th><th>Dates</th><th>Days</th><th>Reason</th><th>Status</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => <Row key={r.id} r={r} onDone={(m) => { setNotice(m); void q.reload() }} />)}
              </tbody>
            </table>
          </div>
        )}
      </section>

    </>
  )
}

function Row({ r, onDone }: { r: Item; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function decide(approve: boolean) {
    let note: string | null = null
    if (!approve) {
      note = window.prompt('Why are you rejecting it? The employee is told.')
      if (!note || !note.trim()) return
    }
    setBusy(true); setError(null)
    try {
      await api.post(`/leave/applications/${r.id}/decision`, { approve, note })
      onDone(approve ? `Approved ${r.name}’s leave.` : `Rejected ${r.name}’s leave.`)
    } catch (err) {
      setError(errorText(err))
    } finally { setBusy(false) }
  }
  return (
    <tr>
      <td><span className="ld-who"><span className="ld-av">{r.name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()}</span><b>{r.name}</b></span></td>
      <td><span className="ld-dot" style={{ background: r.color ?? '#0ea5e9' }} />{r.leave_type}</td>
      <td>{range(r.start_date, r.end_date)}{r.is_half_day && <div className="muted-sm">{r.half_day_session === 'second_half' ? 'Second half' : 'First half'}</div>}</td>
      <td>{days(r.duration_milli_days)}</td>
      <td className="muted-sm">{r.reason ?? '—'}{r.contact_phone && <div>☎ {r.contact_phone}</div>}</td>
      <td><span className={`ld-status ld-s-${r.status}`}>{r.status === 'pending' ? 'Awaiting' : r.status[0].toUpperCase() + r.status.slice(1)}</span>{error && <div className="muted-sm" style={{ color: 'var(--unprod)' }}>{error}</div>}</td>
      <td className="ld-act">
        {r.waiting_on_me && (
          <>
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void decide(true)}>Approve</button>{' '}
            <button className="btn btn-sm" disabled={busy} onClick={() => void decide(false)}>Reject</button>
          </>
        )}
      </td>
    </tr>
  )
}

/* ---------------------------------------------------------------- apply -- */

interface Person { id: string; name: string; code: string | null }
interface LeaveType { id: string; name: string; allow_half_day: boolean; is_active: boolean }
interface Preview { duration_milli_days: number; available_milli_days: number; pending_milli_days: number; used_milli_days: number }

function ApplyDialog({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
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
  return (
    <Dialog title="Apply for leave" subtitle="Goes to the reporting manager first, then HR" onClose={onClose} medium
            footer={<><button className="btn" type="button" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" form="ld-apply" disabled={busy || !typeKey || !who}>{busy ? 'Applying…' : 'Apply'}</button></>}>
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
        <div className="ld-summary">
          <b><IconCheck size={15} /> {p ? (p.duration_milli_days === 500 ? 'half a day' : days(p.duration_milli_days)) : '…'}</b>
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
            <input value={contact} maxLength={40} onChange={(e) => setContact(e.target.value)} placeholder="Mobile or an alternate number" /></label>
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
      </form>
    </Dialog>
  )
}

/* ------------------------------------------------------------- balances -- */

interface Matrix {
  year: number; years: Array<{ year: number; label: string }>
  types: Array<{ id: string; code: string; name: string; color: string }>
  rows: Array<{ user_id: string; name: string; code: string | null; department: string | null; cells: Record<string, { balance: number; entitled: number }> }>
}
const num = (milli: number) => String(Math.round(milli / 100) / 10)

function BalancesTab() {
  const { user } = useAuth()
  const [year, setYear] = useState<number | null>(null)
  const [dept, setDept] = useState('')
  const [carry, setCarry] = useState(false)
  const q = useQuery<Matrix>(`leave-desk-matrix:${year ?? 'now'}`, () => api.get<Matrix>(`/leave/balances/matrix${year ? `?year=${year}` : ''}`))
  if (q.error) return <ErrorNote>{errorText(q.error)}</ErrorNote>
  if (!q.data) return <Loading />
  const m = q.data
  const depts = Array.from(new Set(m.rows.map((r) => r.department).filter(Boolean))) as string[]
  const rows = m.rows.filter((r) => !dept || r.department === dept)
  const label = m.years.find((y) => y.year === m.year)?.label ?? String(m.year)
  return (
    <section className="card ld-card">
      <div className="ld-bar">
        <div><b>Leave Balance</b><div className="muted-sm">Leave year {label}</div></div>
        <div className="ld-bar-right">
          <select value={m.year} onChange={(e) => setYear(Number(e.target.value))}>{m.years.map((y) => <option key={y.year} value={y.year}>{y.label}</option>)}</select>
          <select value={dept} onChange={(e) => setDept(e.target.value)}><option value="">All departments</option>{depts.map((d) => <option key={d}>{d}</option>)}</select>
          {canAdminister(user) && <button type="button" className="btn" onClick={() => setCarry(true)}>↻ Carry forward</button>}
        </div>
      </div>
      {rows.length === 0 ? <Empty>No employees to show.</Empty> : (
        <div className="table-wrap">
          <table className="ld-matrix">
            <thead><tr><th>EMPLOYEE</th>{m.types.map((t) => <th key={t.id} className="ld-c">{t.code}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.user_id}>
                  <td><b>{r.name}</b><div className="muted-sm">{[r.code, r.department].filter(Boolean).join(' · ')}</div></td>
                  {m.types.map((t) => {
                    const c = r.cells[t.id]
                    return <td key={t.id} className="ld-c"><b style={{ color: c.entitled ? t.color : undefined }} className={c.entitled ? '' : 'muted-sm'}>{num(c.balance)}</b><div className="muted-sm">of {num(c.entitled)}</div></td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {carry && <CarryDialog years={m.years} current={m.year} onClose={() => setCarry(false)} onDone={() => { setCarry(false); void q.reload() }} />}
    </section>
  )
}

function CarryDialog({ years, current, onClose, onDone }: { years: Matrix['years']; current: number; onClose: () => void; onDone: () => void }) {
  const [from, setFrom] = useState(current - 1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const into = from + 1
  const label = (y: number) => years.find((x) => x.year === y)?.label ?? String(y)
  async function run() {
    setBusy(true); setError(null)
    try {
      const r = await api.post<{ people: number; carried_milli_days: number; lapsed_milli_days: number }>('/leave/carry-forward', { from_year: from, into_year: into })
      setResult(`Carried ${days(r.carried_milli_days)} for ${r.people} people; ${days(r.lapsed_milli_days)} lapsed.`)
    } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }
  return (
    <Dialog title="Carry balances forward" onClose={result ? onDone : onClose} narrow
            footer={result ? <button className="btn btn-primary" onClick={onDone}>Done</button> : <><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={() => void run()}>{busy ? 'Running…' : 'Run'}</button></>}>
      <div className="ld-two">
        <label>From<select value={from} onChange={(e) => setFrom(Number(e.target.value))}>{[current - 2, current - 1, current].map((y) => <option key={y} value={y}>{label(y)}</option>)}</select></label>
        <label>Into<select value={into} disabled><option>{label(into)}</option></select></label>
      </div>
      <p className="muted-sm" style={{ marginTop: 12 }}>Types that carry forward move what is left, up to each type’s cap. Types that do not carry forward are written off as lapsed, so the ledger explains where the days went. Running this twice does nothing the second time.</p>
      {result && <div className="notice notice-ok">{result}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}
    </Dialog>
  )
}

/* ------------------------------------------------------------- calendar -- */

interface CalItem { id: string; user_id: string; name: string; department: string | null; leave_type: string; color: string; start_date: string; end_date: string; status: string; is_half_day: boolean }
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function CalendarTab() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [dept, setDept] = useState('')
  const q = useQuery<{ items: CalItem[] }>(`leave-desk-cal:${year}-${month}`, () => api.get<{ items: CalItem[] }>(`/leave/calendar?year=${year}&month=${month}`))
  const step = (by: number) => { const d = new Date(year, month - 1 + by, 1); setYear(d.getFullYear()); setMonth(d.getMonth() + 1) }
  const items = (q.data?.items ?? []).filter((i) => !dept || i.department === dept)
  const depts = useMemo(() => Array.from(new Set((q.data?.items ?? []).map((i) => i.department).filter(Boolean))) as string[], [q.data])
  const last = new Date(year, month, 0).getDate()
  const people = Array.from(new Map(items.map((i) => [i.user_id, i.name])).entries())
  const iso = (d: number) => `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`

  return (
    <section className="card ld-card">
      <div className="ld-bar">
        <div className="ld-bar-right">
          <button type="button" className="btn" aria-label="Previous month" onClick={() => step(-1)}>‹</button>
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>{[year - 2, year - 1, year, year + 1, year + 2].map((y) => <option key={y}>{y}</option>)}</select>
          <button type="button" className="btn" aria-label="Next month" onClick={() => step(1)}>›</button>
        </div>
        <select value={dept} onChange={(e) => setDept(e.target.value)}><option value="">All departments</option>{depts.map((d) => <option key={d}>{d}</option>)}</select>
      </div>
      {q.error ? <ErrorNote>{errorText(q.error)}</ErrorNote> : !q.data ? <Loading /> : people.length === 0 ? (
        <div className="ld-empty"><b>Nobody is on leave this month</b><p>Approved and pending leave both appear here.</p></div>
      ) : (
        <div className="table-wrap">
          <table className="ld-cal">
            <thead><tr><th>Employee</th>{Array.from({ length: last }, (_, i) => {
              const dow = new Date(year, month - 1, i + 1).getDay()
              const isToday = iso(i + 1) === todayISO()
              return (
                <th key={i} className={`ld-d ld-dh${dow === 0 || dow === 6 ? ' ld-wk' : ''}${isToday ? ' ld-today' : ''}`}>
                  <span className="ld-dow">{'SMTWTFS'[dow]}</span>
                  <span className="ld-dn">{i + 1}</span>
                </th>
              )
            })}</tr></thead>
            <tbody>
              {people.map(([uid, name]) => (
                <tr key={uid}>
                  <td><span className="ld-who"><span className="ld-av">{name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()}</span>{name}</span></td>
                  {Array.from({ length: last }, (_, i) => {
                    const day = iso(i + 1)
                    const dow = new Date(year, month - 1, i + 1).getDay()
                    const hit = items.find((x) => x.user_id === uid && x.start_date <= day && x.end_date >= day)
                    return <td key={i} className={`ld-d${dow === 0 || dow === 6 ? ' ld-wk' : ''}${hit ? (hit.status === 'pending' ? ' ld-pend' : ' ld-on') : ''}`} style={hit ? { ['--c' as string]: hit.color } : undefined} title={hit ? `${hit.leave_type}${hit.status === 'pending' ? ' (awaiting)' : ''}` : undefined} />
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="ld-legend"><span className="ld-key ld-on" /> Approved <span className="ld-key ld-pend" /> Awaiting approval <span className="muted-sm">Colours are the leave type’s own.</span></div>
    </section>
  )
}
