import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import '../styles/timesheets.css'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { useAuth } from '../lib/auth'
import { todayISO } from '../lib/format'
import type { Project } from '../lib/types'
import { Loading, ErrorNote, StatTile } from '../components/ui'
import { ExportButton } from '../components/ExportButton'

type Period = 'daily' | 'weekly' | 'monthly'

interface DayRow {
  date: string
  weekday: string
  is_working_day: boolean
  tracked_minutes: number
  entered_minutes: number
  worked_minutes: number
  active_minutes: number
  idle_minutes: number
  billable_minutes: number
  non_billable_minutes: number
  expected_minutes: number
  overtime_minutes: number
  shortfall_minutes: number
  first_activity: string | null
  last_activity: string | null
}

interface Totals {
  tracked_minutes: number
  entered_minutes: number
  worked_minutes: number
  active_minutes: number
  idle_minutes: number
  billable_minutes: number
  non_billable_minutes: number
  expected_minutes: number
  overtime_minutes: number
  shortfall_minutes: number
  days_worked: number
  working_days: number
}

interface Approval {
  id?: string
  status: 'draft' | 'submitted' | 'approved' | 'rejected'
  submitted_at?: string | null
  reviewed_at?: string | null
  note?: string | null
  approved_worked_minutes?: number
  approved_overtime_minutes?: number
}

interface Entry {
  id: string
  entry_date: string
  minutes: number
  project_id: string | null
  project_name: string | null
  description: string | null
  is_billable: boolean
  source: string
}

interface Sheet {
  user_id: string
  full_name: string
  period_type: Period
  period_start: string
  period_end: string
  timezone: string
  days: DayRow[]
  totals: Totals
  approval: Approval
  entries: Entry[]
  can_edit: boolean
  can_review: boolean
}

interface TeamSheet {
  period_start: string
  period_end: string
  rows: Array<{ user_id: string; full_name: string; email: string; totals: Totals; approval: Approval }>
  totals: Record<string, number>
  pending_approvals: number
}

/** Minutes → "7h 30m". Never a decimal — payroll reads this, not a chart. */
export function hm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  if (m === 0) return '—'
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (h === 0) return `${rest}m`
  if (rest === 0) return `${h}h`
  return `${h}h ${rest}m`
}

function shiftPeriod(iso: string, period: Period, direction: -1 | 1): string {
  const d = new Date(`${iso}T12:00:00`)
  if (period === 'daily') d.setDate(d.getDate() + direction)
  else if (period === 'weekly') d.setDate(d.getDate() + 7 * direction)
  else d.setMonth(d.getMonth() + direction)
  return d.toISOString().slice(0, 10)
}

const STATUS_TEXT: Record<Approval['status'], string> = {
  draft: 'Draft',
  submitted: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Changes requested',
}

export function ApprovalPill({ status }: { status: Approval['status'] }) {
  return <span className={`ts-pill ts-${status}`}>{STATUS_TEXT[status]}</span>
}

/** The period on screen, as the dates the export endpoint wants.

 Mirrors shiftPeriod's definition of a period, so the file and the table can
 never disagree about which week "this week" is. */
function periodBounds(iso: string, period: Period): { start: string; end: string } {
  const d = new Date(`${iso}T12:00:00`)
  if (period === 'daily') return { start: iso, end: iso }
  if (period === 'weekly') {
    const monday = new Date(d)
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    const sunday = new Date(monday)
    sunday.setDate(monday.getDate() + 6)
    return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) }
  }
  const first = new Date(d.getFullYear(), d.getMonth(), 1, 12)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0, 12)
  return { start: first.toISOString().slice(0, 10), end: last.toISOString().slice(0, 10) }
}

export default function Timesheets() {
  const { user } = useAuth()
  const canSeeTeam = user?.role !== 'employee'
  const [view, setView] = useState<'mine' | 'team'>(canSeeTeam ? 'team' : 'mine')
  const [period, setPeriod] = useState<Period>('weekly')
  const [day, setDay] = useState(todayISO())
  const [subject, setSubject] = useState<string>('')
  const bounds = periodBounds(day, period)

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Timesheets</h1>
          <p className="page-sub">
            Hours derived from tracked activity plus anything entered by hand.
          </p>
        </div>
        {/* The endpoint takes start and end and this sent neither, so narrowing
            to one week and exporting silently produced the default 28 days. The
            file now matches the period on screen. */}
        <ExportButton
          href={`/timesheets/export.csv?start=${bounds.start}&end=${bounds.end}`}
          filename={`timesheets-${bounds.start}-to-${bounds.end}.csv`}
        />
      </div>

      <div className="filter-row">
        {canSeeTeam && (
          <div className="ts-toggle" role="group" aria-label="View">
            {(['team', 'mine'] as const).map((v) => (
              <button
                key={v}
                className={`ts-toggle-btn ${view === v ? 'ts-toggle-on' : ''}`}
                onClick={() => { setView(v); setSubject('') }}
                aria-pressed={view === v}
              >
                {v === 'team' ? 'Team' : 'Mine'}
              </button>
            ))}
          </div>
        )}

        <div className="ts-toggle" role="group" aria-label="Period">
          {(['daily', 'weekly', 'monthly'] as const).map((p) => (
            <button
              key={p}
              className={`ts-toggle-btn ${period === p ? 'ts-toggle-on' : ''}`}
              onClick={() => setPeriod(p)}
              aria-pressed={period === p}
            >
              {p[0].toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>

        <div className="ts-nav">
          <button className="btn btn-sm" onClick={() => setDay(shiftPeriod(day, period, -1))} aria-label="Previous period">←</button>
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          <button className="btn btn-sm" onClick={() => setDay(shiftPeriod(day, period, 1))} aria-label="Next period">→</button>
          <button className="btn btn-sm" onClick={() => setDay(todayISO())} disabled={day === todayISO()}>
            Today
          </button>
        </div>
      </div>

      {view === 'team' && !subject ? (
        <TeamView period={period} day={day} onOpen={setSubject} />
      ) : (
        <PersonView
          period={period}
          day={day}
          userId={view === 'team' ? subject : undefined}
          onBack={view === 'team' ? () => setSubject('') : undefined}
        />
      )}
    </div>
  )
}

/* ----------------------------------------------------------------- team --- */

function TeamView({
  period,
  day,
  onOpen,
}: {
  period: Period
  day: string
  onOpen: (userId: string) => void
}) {
  const { data, error, loading, refetching } = useQuery<TeamSheet>(
    `ts-team:${period}:${day}`,
    () => api.get<TeamSheet>(`/timesheets/team?day=${day}&period=${period}`),
  )

  if (error) return <ErrorNote>{error}</ErrorNote>
  if (loading || !data) return <Loading />

  return (
    <div className={refetching ? 'refetching' : undefined}>
      <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
        <StatTile label="Worked" value={hm(data.totals.worked_minutes)} meta={`${data.period_start} → ${data.period_end}`} />
        <StatTile label="Expected" value={hm(data.totals.expected_minutes)} />
        <StatTile label="Billable" value={hm(data.totals.billable_minutes)} accent="var(--prod)" />
        <StatTile label="Overtime" value={hm(data.totals.overtime_minutes)} accent={data.totals.overtime_minutes > 0 ? 'var(--unprod)' : undefined} />
        <StatTile
          label="Awaiting approval"
          value={String(data.pending_approvals)}
          meta={data.pending_approvals ? 'needs your review' : 'nothing pending'}
        />
      </div>

      <section className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th><th className="num">Tracked</th><th className="num">Entered</th>
                <th className="num">Worked</th><th className="num">Expected</th>
                <th className="num">Overtime</th><th className="num">Billable</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.user_id}>
                  <td>
                    <button className="link-btn" onClick={() => onOpen(row.user_id)}>
                      {row.full_name}
                    </button>
                    <div className="muted-sm">{row.email}</div>
                  </td>
                  <td className="num">{hm(row.totals.tracked_minutes)}</td>
                  <td className="num">{hm(row.totals.entered_minutes)}</td>
                  <td className="num"><b>{hm(row.totals.worked_minutes)}</b></td>
                  <td className="num">{hm(row.totals.expected_minutes)}</td>
                  <td className={`num ${row.totals.overtime_minutes > 0 ? 'ts-over' : ''}`}>
                    {hm(row.totals.overtime_minutes)}
                  </td>
                  <td className="num">{hm(row.totals.billable_minutes)}</td>
                  <td><ApprovalPill status={row.approval.status} /></td>
                </tr>
              ))}
              {data.rows.length === 0 && (
                <tr><td colSpan={8} className="empty">Nobody in scope.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

/* --------------------------------------------------------------- person --- */

function PersonView({
  period,
  day,
  userId,
  onBack,
}: {
  period: Period
  day: string
  userId?: string
  onBack?: () => void
}) {
  const query = `day=${day}&period=${period}${userId ? `&user_id=${userId}` : ''}`
  const { data, error, loading, reload } = useQuery<Sheet>(`ts:${query}`, () =>
    api.get<Sheet>(`/timesheets?${query}`),
  )
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  if (error) return <ErrorNote>{error}</ErrorNote>
  if (loading || !data) return <Loading />

  const { totals, approval } = data
  const locked = approval.status === 'submitted' || approval.status === 'approved'

  async function act(fn: () => Promise<unknown>, message: string) {
    setBusy(true)
    setActionError(null)
    setNotice(null)
    try {
      await fn()
      reload()
      setNotice(message)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      {onBack && (
        <button className="ts-back" onClick={onBack}>← Back to team</button>
      )}

      <div className="page-head" style={{ marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 650 }}>{data.full_name}</h2>
          <p className="page-sub">
            {data.period_start} → {data.period_end} · {data.timezone}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <ApprovalPill status={approval.status} />
          {!locked && (
            <button
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() =>
                act(
                  () => api.post(`/timesheets/submit?${query}`),
                  'Submitted for approval.',
                )
              }
            >
              Submit for approval
            </button>
          )}
          {data.can_review && approval.status === 'submitted' && (
            <>
              <button
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() =>
                  act(
                    () => api.post(`/timesheets/${data.user_id}/approve?${query}`, { note: null }),
                    'Approved. Totals are frozen at this figure.',
                  )
                }
              >
                Approve
              </button>
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() => {
                  const note = window.prompt('What needs correcting?')
                  if (!note?.trim()) return
                  void act(
                    () =>
                      api.post(`/timesheets/${data.user_id}/reject?${query}`, {
                        note: note.trim(),
                      }),
                    'Sent back for changes.',
                  )
                }}
              >
                Request changes
              </button>
            </>
          )}
        </div>
      </div>

      {notice && <div className="notice" style={{ marginBottom: 14 }}>{notice}</div>}
      {actionError && <ErrorNote>{actionError}</ErrorNote>}

      {approval.status === 'rejected' && approval.note && (
        <div className="ts-warn" style={{ marginBottom: 14 }}>
          <b>Changes requested.</b> {approval.note}
        </div>
      )}
      {approval.status === 'approved' && (
        <div className="notice" style={{ marginBottom: 14 }}>
          Approved at <b>{hm(approval.approved_worked_minutes ?? 0)}</b> worked
          {approval.approved_overtime_minutes
            ? `, including ${hm(approval.approved_overtime_minutes)} overtime`
            : ''}
          . That figure is frozen — later corrections to activity will not change it.
        </div>
      )}

      <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
        <StatTile
          label="Worked"
          value={hm(totals.worked_minutes)}
          meta={`${hm(totals.tracked_minutes)} tracked + ${hm(totals.entered_minutes)} entered`}
        />
        <StatTile label="Expected" value={hm(totals.expected_minutes)} meta={`${totals.working_days} working days`} />
        <StatTile
          label="Overtime"
          value={hm(totals.overtime_minutes)}
          accent={totals.overtime_minutes > 0 ? 'var(--unprod)' : undefined}
        />
        <StatTile label="Shortfall" value={hm(totals.shortfall_minutes)} />
        <StatTile label="Billable" value={hm(totals.billable_minutes)} accent="var(--prod)" />
      </div>

      <section className="card" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <h2 className="card-title">Days</h2>
          <span className="card-note">{totals.days_worked} of {totals.working_days} worked</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Day</th><th className="num">Tracked</th><th className="num">Entered</th>
                <th className="num">Worked</th><th className="num">Expected</th>
                <th className="num">Over/short</th><th className="num">Idle</th><th>Span</th>
              </tr>
            </thead>
            <tbody>
              {data.days.map((row) => (
                <tr key={row.date} className={!row.is_working_day ? 'ts-offday' : undefined}>
                  <td>
                    <b>{row.weekday}</b> <span className="muted-sm">{row.date.slice(5)}</span>
                    {!row.is_working_day && <span className="badge" style={{ marginLeft: 8 }}>off</span>}
                  </td>
                  <td className="num">{hm(row.tracked_minutes)}</td>
                  <td className="num">{hm(row.entered_minutes)}</td>
                  <td className="num"><b>{hm(row.worked_minutes)}</b></td>
                  <td className="num muted-sm">{hm(row.expected_minutes)}</td>
                  <td className="num">
                    {row.overtime_minutes > 0 ? (
                      <span className="ts-over">+{hm(row.overtime_minutes)}</span>
                    ) : row.shortfall_minutes > 0 ? (
                      <span className="ts-short">−{hm(row.shortfall_minutes)}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="num muted-sm">{hm(row.idle_minutes)}</td>
                  <td className="muted-sm">
                    {row.first_activity
                      ? `${row.first_activity.slice(11, 16)}–${(row.last_activity ?? '').slice(11, 16)}`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Entered by hand</h2>
          {data.can_edit && (
            <button className="btn btn-sm" onClick={() => setAdding((v) => !v)}>
              {adding ? 'Cancel' : 'Add entry'}
            </button>
          )}
        </div>

        {locked && (
          <p className="setting-hint" style={{ marginTop: -6, marginBottom: 12 }}>
            This period is {approval.status}. Entries are frozen
            {data.can_edit ? ' for everyone except administrators.' : '.'}
          </p>
        )}

        {adding && (
          <AddEntry
            userId={userId}
            defaultDate={data.days.find((d) => d.is_working_day)?.date ?? data.period_start}
            onDone={() => { setAdding(false); reload() }}
          />
        )}

        {data.entries.length === 0 ? (
          <p className="empty">
            Nothing entered by hand. Use this for work the agent cannot see — client meetings,
            phone calls, time on site.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Date</th><th className="num">Time</th><th>Project</th><th>Note</th><th>Billable</th><th /></tr>
              </thead>
              <tbody>
                {data.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.entry_date}</td>
                    <td className="num">{hm(entry.minutes)}</td>
                    <td>
                      {entry.project_id ? (
                        <Link className="row-link" to={`/projects/${entry.project_id}`}>
                          {entry.project_name}
                        </Link>
                      ) : (
                        <span className="muted-sm">—</span>
                      )}
                    </td>
                    <td className="muted-sm">{entry.description ?? ''}</td>
                    <td>{entry.is_billable ? <span className="badge">Billable</span> : ''}</td>
                    <td className="num">
                      {data.can_edit && (
                        <button
                          className="btn btn-sm"
                          onClick={() =>
                            act(
                              () => api.del(`/timesheets/entries/${entry.id}`),
                              'Entry removed.',
                            )
                          }
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function AddEntry({
  userId,
  defaultDate,
  onDone,
}: {
  userId?: string
  defaultDate: string
  onDone: () => void
}) {
  const [form, setForm] = useState({
    entry_date: defaultDate,
    hours: 1,
    project_id: '',
    description: '',
    is_billable: false,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const projects = useQuery<Project[]>('projects:false', () => api.get<Project[]>('/projects'))

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/timesheets/entries', {
        user_id: userId ?? null,
        entry_date: form.entry_date,
        // The form asks for hours because that is how people think about a
        // meeting; the API stores minutes because that is what adds up.
        minutes: Math.round(form.hours * 60),
        project_id: form.project_id || null,
        description: form.description || null,
        is_billable: form.is_billable,
      })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the entry')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ts-entry-form" onSubmit={submit}>
      {error && <div style={{ marginBottom: 12 }}><ErrorNote>{error}</ErrorNote></div>}
      <div className="settings-grid">
        <label className="setting">
          Date
          <input type="date" value={form.entry_date} onChange={(e) => setForm({ ...form, entry_date: e.target.value })} required />
        </label>
        <label className="setting">
          Hours
          <input
            type="number"
            min={0.25}
            max={24}
            step={0.25}
            value={form.hours}
            onChange={(e) => setForm({ ...form, hours: Number(e.target.value) })}
            required
          />
        </label>
        <label className="setting">
          Project
          <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })}>
            <option value="">None</option>
            {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="setting">
          What was it?
          <input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Client workshop, offsite"
          />
        </label>
        <div className="setting">
          <label className="switch-row">
            <input type="checkbox" checked={form.is_billable} onChange={(e) => setForm({ ...form, is_billable: e.target.checked })} />
            <span>Billable</span>
          </label>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Add entry'}</button>
      </div>
    </form>
  )
}
