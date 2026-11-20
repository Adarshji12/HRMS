/* Shift Master — working hours, grace time and week offs.
 *
 * The same shifts Attendance reads: the start and end, the grace after which a punch is
 * late, the hours that make a half and a full day, and the days off. A shift with week offs
 * of its own decides which days are weekly offs for the people on it; with none chosen the
 * work schedule's weekly off applies. The default shift is given to each new employee.
 */

import { useMemo, useState } from 'react'
import '../../styles/crm.css'
import '../../styles/org.css'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { canAdminister, useAuth } from '../../lib/auth'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconClock, IconEdit, IconPlus, IconSearch, IconTrash } from '../../components/Icons'
import { Dialog, Field } from '../crm/parts'

export interface ShiftRow {
  id: string
  name: string
  start_time: string
  end_time: string
  grace_minutes: number
  half_day_threshold_minutes: number
  is_night_shift: boolean
  is_active: boolean
  full_day_minutes: number
  break_minutes: number
  week_offs: Record<string, string> | null
  color: string
  is_default: boolean
  assigned_count: number
}

const DAYS: Array<{ key: string; label: string }> = [
  { key: 'sun', label: 'Sun' }, { key: 'mon', label: 'Mon' }, { key: 'tue', label: 'Tue' }, { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' }, { key: 'fri', label: 'Fri' }, { key: 'sat', label: 'Sat' },
]
const OCCURRENCES: Array<{ key: string; label: string }> = [
  { key: '1', label: '1st' }, { key: '2', label: '2nd' }, { key: '3', label: '3rd' }, { key: '4', label: '4th' },
  { key: '5', label: '5th' }, { key: 'last', label: 'Last' },
]
const dayLabel = (key: string) => DAYS.find((d) => d.key === key)?.label ?? key

/** "Sun" or "Sat (2nd, 4th), Sun" — the week offs in words. */
export function describeOffs(offs: Record<string, string> | null): string {
  if (!offs || Object.keys(offs).length === 0) return ''
  return DAYS.filter((d) => offs[d.key])
    .map((d) => {
      const rule = offs[d.key]
      if (rule === 'all') return d.label
      const which = rule.split(',').map((p) => OCCURRENCES.find((o) => o.key === p)?.label ?? p)
      return `${d.label} (${which.join(', ')})`
    })
    .join(', ')
}

const hoursText = (minutes: number) => String(Math.round((minutes / 60) * 100) / 100)

export default function ShiftMaster({ onChanged }: { onChanged?: () => void }) {
  const { user } = useAuth()
  const isAdmin = canAdminister(user)
  const shifts = useQuery<ShiftRow[]>('att-shifts-master', () => api.get<ShiftRow[]>('/attendance/shifts'))
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<ShiftRow | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (shifts.data ?? []).filter((s) => !needle || s.name.toLowerCase().includes(needle))
  }, [shifts.data, q])

  const changed = () => { shifts.reload(); onChanged?.() }

  async function remove(shift: ShiftRow) {
    if (!window.confirm(`Delete “${shift.name}”?`)) return
    setError(null)
    try {
      await api.del(`/attendance/shifts/${shift.id}`)
      changed()
    } catch (err) {
      const detail = (err as { message?: string }).message
      setError(detail ?? 'That shift could not be deleted')
    }
  }

  const total = shifts.data?.length ?? 0

  return (
    <div className="crm">
      <section className="card dm-card">
        <div className="dm-head">
          <span className="dm-tile dm-tile-violet"><IconClock size={18} /></span>
          <div className="dm-heading">
            <h1 className="dm-title">Shift Master</h1>
            <p className="crm-sub">Working hours, grace time and week offs. Applied once Attendance is live.</p>
          </div>
          <div className="dm-tools">
            <div className="crm-search dm-search">
              <IconSearch size={15} />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search shifts…" aria-label="Search shifts" />
            </div>
            <span className="crm-sub crm-nowrap">{total} shift{total === 1 ? '' : 's'}</span>
            {isAdmin && (
              <button className="btn btn-primary" onClick={() => setEditing('new')}>
                <IconPlus size={15} /> Add Shift
              </button>
            )}
          </div>
        </div>

        {(error || shifts.error) && <div className="dm-error"><ErrorNote>{error ?? shifts.error}</ErrorNote></div>}

        {shifts.loading && !shifts.data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState
            title={q ? 'No shift matches that search' : 'No shifts yet'}
            body={q ? 'Try a different name.' : 'Add the standard working day first, then put people on it in the roster.'}
            action={isAdmin && !q ? <button className="btn btn-primary" onClick={() => setEditing('new')}>Add the first one</button> : undefined}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Shift</th><th>Timing</th><th>Grace</th><th className="crm-num">Employees</th><th>Status</th>
                  {isAdmin && <th style={{ textAlign: 'right' }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <span className="sm-dot" style={{ background: s.color }} aria-hidden />
                      <span className="crm-strong">{s.name}</span>
                      {s.is_default && <span className="sm-default">default</span>}
                      <div className="crm-sub sm-offs">{describeOffs(s.week_offs) || 'Follows the work schedule'}</div>
                    </td>
                    <td className="sm-mono">{s.start_time} – {s.end_time}</td>
                    <td className="crm-muted sm-mono">{s.grace_minutes} min</td>
                    <td className="crm-num dm-count">{s.assigned_count}</td>
                    <td>
                      <span className={`crm-state ${s.is_active ? 'crm-state-good' : 'crm-state-idle'}`}>{s.is_active ? 'Active' : 'Inactive'}</span>
                    </td>
                    {isAdmin && (
                      <td>
                        <div className="crm-row-actions">
                          <button className="crm-icon-btn" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`} title="Edit"><IconEdit size={16} /></button>
                          <button className="crm-icon-btn dm-delete" onClick={() => remove(s)} aria-label={`Delete ${s.name}`} title="Delete"><IconTrash size={16} /></button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && (
        <ShiftDialog
          shift={editing === 'new' ? null : editing}
          firstShift={total === 0}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); changed() }}
        />
      )}
    </div>
  )
}

/** The week-off choice in the form: a day is off every week, or only on some occurrences. */
type Offs = Record<string, { all: boolean; which: string[] }>

function toOffs(raw: Record<string, string> | null | undefined): Offs {
  const out: Offs = {}
  for (const [day, rule] of Object.entries(raw ?? {})) {
    out[day] = rule === 'all' ? { all: true, which: [] } : { all: false, which: rule.split(',') }
  }
  return out
}

function ShiftDialog({
  shift, firstShift, onClose, onSaved,
}: {
  shift: ShiftRow | null
  firstShift: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    name: shift?.name ?? '',
    start_time: shift?.start_time ?? '09:30',
    end_time: shift?.end_time ?? '18:30',
    grace: String(shift?.grace_minutes ?? 15),
    half: hoursText(shift?.half_day_threshold_minutes ?? 240),
    full: hoursText(shift?.full_day_minutes ?? 480),
    brk: String(shift?.break_minutes ?? 60),
    color: shift?.color ?? '#2563eb',
    is_default: shift?.is_default ?? firstShift,
    is_active: shift?.is_active ?? true,
  })
  const [offs, setOffs] = useState<Offs>(() => toOffs(shift?.week_offs ?? (shift ? null : { sun: 'all' })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  function toggleDay(day: string) {
    const next = { ...offs }
    if (next[day]) delete next[day]
    else next[day] = { all: true, which: [] }
    setOffs(next)
  }
  function everyWeek(day: string) {
    setOffs({ ...offs, [day]: { all: true, which: [] } })
  }
  function toggleOccurrence(day: string, key: string) {
    const current = offs[day]
    const which = current.all ? [key] : current.which.includes(key) ? current.which.filter((k) => k !== key) : [...current.which, key]
    setOffs({ ...offs, [day]: which.length === 0 ? { all: true, which: [] } : { all: false, which } })
  }

  const summary = describeOffs(Object.fromEntries(Object.entries(offs).map(([d, o]) => [d, o.all ? 'all' : o.which.join(',')])))

  async function save() {
    if (!form.name.trim()) return setError('Give the shift a name.')
    const grace = Number(form.grace)
    const half = Number(form.half)
    const full = Number(form.full)
    const brk = Number(form.brk)
    if (!Number.isInteger(grace) || grace < 0 || grace > 240) return setError('Grace is a whole number of minutes, 0 to 240.')
    if (!(half >= 0.5 && half <= 12)) return setError('Half day is between 0.5 and 12 hours.')
    if (!(full >= 1 && full <= 24)) return setError('Full day is between 1 and 24 hours.')
    if (!Number.isInteger(brk) || brk < 0 || brk > 480) return setError('Break is a whole number of minutes, 0 to 480.')
    setBusy(true)
    setError(null)
    const body = {
      name: form.name.trim(),
      start_time: form.start_time,
      end_time: form.end_time,
      grace_minutes: grace,
      half_day_threshold_minutes: Math.round(half * 60),
      full_day_minutes: Math.round(full * 60),
      break_minutes: brk,
      // A shift that ends at or before it starts runs past midnight.
      is_night_shift: shift ? shift.is_night_shift : form.end_time <= form.start_time,
      week_offs: Object.keys(offs).length === 0
        ? null
        : Object.fromEntries(Object.entries(offs).map(([d, o]) => [d, o.all ? 'all' : o.which.join(',')])),
      color: form.color,
      is_default: form.is_default,
      is_active: form.is_active,
    }
    try {
      if (shift) await api.patch(`/attendance/shifts/${shift.id}`, body)
      else await api.post('/attendance/shifts', body)
      onSaved()
    } catch (err) {
      setError((err as { message?: string }).message ?? 'That shift could not be saved')
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={shift ? `Edit ${shift.name}` : 'Add Shift'}
      medium
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.name.trim()}>
            {busy ? 'Saving…' : shift ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      <div className="crm-form">
        {error && <div className="crm-form-wide"><ErrorNote>{error}</ErrorNote></div>}
        <div className="crm-form-wide sm-row-3">
          <Field label="Shift name" required>
            <input value={form.name} placeholder="General Shift" autoFocus onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Starts">
            <input type="time" value={form.start_time} onChange={(e) => set({ start_time: e.target.value })} />
          </Field>
          <Field label="Ends">
            <input type="time" value={form.end_time} onChange={(e) => set({ end_time: e.target.value })} />
          </Field>
        </div>
        <div className="crm-form-wide sm-row-4">
          <Field label="Grace (min)" hint="Late after this">
            <input value={form.grace} type="number" data-spin min={0} step={1} onChange={(e) => set({ grace: e.target.value })} />
          </Field>
          <Field label="Half day (hrs)">
            <input value={form.half} type="number" data-spin min={0} step="any" onChange={(e) => set({ half: e.target.value })} />
          </Field>
          <Field label="Full day (hrs)">
            <input value={form.full} type="number" data-spin min={0} step="any" onChange={(e) => set({ full: e.target.value })} />
          </Field>
          <Field label="Break (min)">
            <input value={form.brk} type="number" data-spin min={0} step={1} onChange={(e) => set({ brk: e.target.value })} />
          </Field>
        </div>

        <div className="crm-form-wide">
          <span className="crm-field-label">Week offs</span>
          <div className="sm-days" role="group" aria-label="Week offs">
            {DAYS.map((d) => (
              <button key={d.key} type="button" className={`sm-day${offs[d.key] ? ' is-on' : ''}`} aria-pressed={Boolean(offs[d.key])}
                      onClick={() => toggleDay(d.key)}>
                {d.label}
              </button>
            ))}
          </div>
          {DAYS.filter((d) => offs[d.key]).map((d) => (
            <div className="sm-occ" key={d.key}>
              <b>{d.label}</b>
              <button type="button" className={`sm-pill${offs[d.key].all ? ' is-on' : ''}`} onClick={() => everyWeek(d.key)}>Every week</button>
              <span className="sm-sep" aria-hidden />
              {OCCURRENCES.map((o) => (
                <button key={o.key} type="button" className={`sm-pill${!offs[d.key].all && offs[d.key].which.includes(o.key) ? ' is-on' : ''}`}
                        onClick={() => toggleOccurrence(d.key, o.key)}>
                  {o.label}
                </button>
              ))}
            </div>
          ))}
          <p className="sm-summary">
            <b>Week offs:</b> {summary || 'none chosen — the work schedule’s weekly off applies'}
          </p>
          <p className="crm-sub">Which days, and which occurrences of them.</p>
        </div>

        <div className="crm-form-wide sm-foot">
          <div className="crm-field">
            <span className="crm-field-label">Colour</span>
            <input type="color" className="sm-color" value={form.color} onChange={(e) => set({ color: e.target.value })} aria-label="Colour" />
          </div>
          <label className="crm-check">
            <input type="checkbox" checked={form.is_default} onChange={(e) => set({ is_default: e.target.checked })} />
            Default shift for new employees
          </label>
          <label className="crm-check">
            <input type="checkbox" checked={form.is_active} onChange={(e) => set({ is_active: e.target.checked })} />
            Active
          </label>
        </div>
      </div>
    </Dialog>
  )
}

export { dayLabel }
