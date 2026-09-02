import { useMemo, useState, type ReactNode } from 'react'
import '../../../styles/attendance.css'
import { ApiError, api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { useAuth } from '../../../lib/auth'
import { clockTime } from '../../../lib/format'
import { Empty, ErrorNote, Loading, StatTile } from '../../../components/ui'
import WorkModePicker, { type WorkMode } from '../../../components/WorkModePicker'
import { DayRegularization, MyRegularizations, type RegRequest } from './regularization'

/* ------------------------------------------------------------------ types --
   Page-local, mirroring app/schemas/attendance.py. Not added to lib/types.ts,
   which is lead-owned. */

export type AttendanceStatus =
  | 'present'
  | 'absent'
  | 'half_day'
  | 'on_leave'
  | 'holiday'
  | 'weekly_off'

export type Enforcement = 'off' | 'flag_only' | 'required'

/** `AttendanceDayOut`. One calendar cell, one muster row. */
export interface AttendanceDay {
  date: string
  status: AttendanceStatus
  check_in_at: string | null
  check_out_at: string | null
  check_in_source: string | null
  check_out_source: string | null
  worked_minutes: number
  is_geo_verified_in: boolean
  is_geo_verified_out: boolean
  check_in_distance_m: number | null
  check_out_distance_m: number | null
  shift_id: string | null
  shift_name: string | null
  shift_start_time: string | null
  shift_end_time: string | null
  is_late: boolean
  late_minutes: number
  is_early_out: boolean
  early_out_minutes: number
  is_missing_punch: boolean
  /** What the employee declared at check-in. Null on rows written before work
   *  modes existed, and on every punch the desktop agent fills in. */
  work_mode: 'office' | 'work_from_home' | 'on_duty' | null
  /** Typed at the punch. Often the only record of which client site an on-duty
   *  day was actually at. */
  note: string | null
  is_regularized: boolean
  has_pending_regularization: boolean
  /** Present on the muster, null on the employee's own calendar. */
  user_id: string | null
  user_name: string | null
}

/** `PunchResultOut`. The verdict is about *this punch*, not about the day. */
interface PunchResult {
  record: AttendanceDay
  is_geo_verified: boolean
  distance_m: number | null
  nearest_office_name: string | null
  enforcement: Enforcement
}

export interface OfficeLocation {
  id: string
  name: string
  address: string | null
  lat: number
  lng: number
  radius_m: number
  is_active: boolean
  created_at: string
}

export interface AttendanceSettingsPayload {
  geofence_enforcement: Enforcement
  active_location_count: number
  /* Per-work-mode overrides. `null` on the wire means "follow
     geofence_enforcement" — the console renders that as a real choice rather
     than a blank, so an administrator can tell a mode that has been decided
     from one riding the default. */
  geofence_office: Enforcement | null
  geofence_work_from_home: Enforcement | null
  geofence_on_duty: Enforcement | null
}

/* ---------------------------------------------------------------- helpers -- */

/** Minutes → "7h 30m". The wire is integer minutes everywhere (D-012). */
export function hm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  if (m === 0) return '—'
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (h === 0) return `${rest}m`
  if (rest === 0) return `${h}h`
  return `${h}h ${rest}m`
}

export interface TypedFailure {
  reason: string | null
  message: string
}

/**
 * Pull a `{reason, message}` refusal back out of an ApiError.
 *
 * The services raise typed details precisely so the console can render prose
 * instead of a status code, and `lib/api.ts` now keeps the `reason` code on
 * `ApiError` rather than flattening the whole detail into the message — so that
 * is what this reads first. Branching on the code and not on the sentence is
 * the point: `pending_request_exists` earns a different offer to the employee
 * than `future_date` does, and matching on prose breaks the first time somebody
 * improves the wording.
 *
 * The JSON fallback below is kept for a browser still holding a client from
 * before that change, where the typed body did arrive stringified in `message`.
 */
export function typedError(err: unknown): TypedFailure {
  if (err instanceof ApiError && err.reason) {
    return { reason: err.reason, message: err.message }
  }
  const raw = err instanceof Error ? err.message : String(err)
  if (raw.startsWith('{')) {
    try {
      const body = JSON.parse(raw) as { reason?: unknown; message?: unknown }
      if (typeof body.message === 'string' && body.message) {
        return {
          reason: typeof body.reason === 'string' ? body.reason : null,
          message: body.message,
        }
      }
    } catch {
      // Not a typed body, or truncated by the client's 300-character cap.
      // Fall through and show whatever text we were given.
    }
  }
  return { reason: null, message: raw }
}

/**
 * Today in the organisation's calendar, not the browser's.
 *
 * The server's attendance day is `local_day(org)` (D-003), so a viewer in
 * another timezone asking for "today" by browser clock would page the wrong
 * day. `en-CA` is the locale that formats as YYYY-MM-DD.
 */
export function orgToday(timezone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  } catch {
    return isoDate(new Date())
  }
}

export function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function addDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + delta)
  return isoDate(date)
}

export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

export const STATUS: Record<AttendanceStatus, { label: string; short: string; color: string }> = {
  present: { label: 'Present', short: 'Present', color: 'var(--status-good)' },
  absent: { label: 'Absent', short: 'Absent', color: 'var(--status-critical)' },
  half_day: { label: 'Half day', short: 'Half day', color: 'var(--status-warn)' },
  on_leave: { label: 'On leave', short: 'Leave', color: 'var(--prod)' },
  holiday: { label: 'Holiday', short: 'Holiday', color: 'var(--brand)' },
  weekly_off: { label: 'Weekly off', short: 'Off', color: 'var(--text-muted)' },
}

/** Status is *stored* by the nightly job (D-010) — never re-derived here. */
export function StatusPill({ status }: { status: AttendanceStatus }) {
  const meta = STATUS[status] ?? { label: status, color: 'var(--text-muted)' }
  return (
    <span className="att-status">
      <span className="att-status-dot" style={{ background: meta.color }} />
      {meta.label}
    </span>
  )
}

/** The read-time verdicts (D-010) plus the two states worth a badge. */
export function DayFlags({ day }: { day: AttendanceDay }) {
  const flags: Array<{ key: string; className: string; text: string; title: string }> = []
  /* First, because it is context for every flag after it rather than a problem
     of its own — UNVERIFIED beside WFH is expected, and beside OFFICE is not.
     Only shown when it is not `office`: the default carries no information, and
     a badge on every ordinary day is furniture. */
  if (day.work_mode && day.work_mode !== 'office') {
    flags.push({
      key: 'mode',
      className: 'att-flag-mode',
      text: day.work_mode === 'work_from_home' ? 'WFH' : 'ON DUTY',
      title:
        (day.work_mode === 'work_from_home'
          ? 'Declared as working from home at check-in.'
          : 'Declared as on duty — client site, field visit or travel.') +
        (day.note ? ` — “${day.note}”` : ''),
    })
  }
  if (day.is_late) {
    flags.push({
      key: 'late',
      className: 'att-flag-late',
      text: `LATE ${day.late_minutes}m`,
      title: `${day.late_minutes} minutes after the shift start${day.shift_name ? ` of ${day.shift_name}` : ''}`,
    })
  }
  if (day.is_early_out) {
    flags.push({
      key: 'early',
      className: 'att-flag-early',
      text: `EARLY ${day.early_out_minutes}m`,
      title: `Left ${day.early_out_minutes} minutes before the shift ended`,
    })
  }
  if (day.is_missing_punch) {
    flags.push({
      key: 'missing',
      className: 'att-flag-missing',
      text: 'NO OUT',
      title: 'Checked in but never checked out',
    })
  }
  if (day.is_regularized) {
    flags.push({
      key: 'reg',
      className: 'att-flag-reg',
      text: 'FIXED',
      // D-028: the badge is also the answer to "why has this day stopped
      // changing". A regularised row is frozen against the nightly job, so
      // without this the employee sees a day that ignores every later
      // correction to the rota and has nothing to explain it.
      title:
        'Corrected by an approved regularisation. The nightly job leaves this day alone from now on, so it no longer follows the rota or the holiday calendar.',
    })
  }
  if (day.has_pending_regularization) {
    flags.push({
      key: 'pending',
      className: 'att-flag-reg',
      text: 'PENDING',
      title: 'A regularisation request for this day is awaiting a decision',
    })
  }
  /* A corrected check-in is *deliberately* not geo-verified — the service
     clears the coordinates on the half it moves, because a latitude captured at
     09:02 is not evidence for a check-in a manager reset to 08:30. Flagging it
     UNVERIFIED beside FIXED reads as a second problem when it is the same one,
     already explained. */
  if (day.check_in_at && !day.is_geo_verified_in && day.check_in_source !== 'regularized') {
    flags.push({
      key: 'geo',
      className: 'att-flag-geo',
      text: 'UNVERIFIED',
      title:
        day.check_in_distance_m != null
          ? `Checked in about ${day.check_in_distance_m} m from the nearest office`
          : 'No location was attached to the check-in, or location checks are off',
    })
  }
  if (flags.length === 0) return null
  return (
    <div className="att-flags">
      {flags.map((f) => (
        <span key={f.key} className={`att-flag ${f.className}`} title={f.title}>
          {f.text}
        </span>
      ))}
    </div>
  )
}

/* ----------------------------------------------------------- geolocation -- */

/** Short on purpose: a permission prompt nobody answers must not strand the
    button, and an unverified punch is a perfectly good punch. */
const GEO_TIMEOUT_MS = 8000

interface Fix {
  lat: number
  lng: number
  accuracy_m: number | null
}

interface GeoAttempt {
  fix: Fix | null
  /** Why there is no fix, in words an employee can read. Never an error. */
  why: string | null
}

const GEO_REASON: Record<number, string> = {
  1: 'you did not allow location access',
  2: 'your device could not work out where it is',
  3: 'finding your location took too long',
}

/**
 * Ask the browser where we are, and give up quickly.
 *
 * Resolves rather than rejects: denial is the *normal* path, and the caller
 * punches either way. `PunchIn.lat`/`lng` are optional server-side for exactly
 * this reason. The extra `setTimeout` is belt and braces — some browsers call
 * neither callback while an unanswered permission prompt sits on screen, and
 * the promise would otherwise never settle.
 */
function requestFix(): Promise<GeoAttempt> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve({ fix: null, why: 'this browser cannot report a location' })
      return
    }
    let settled = false
    const finish = (attempt: GeoAttempt) => {
      if (settled) return
      settled = true
      resolve(attempt)
    }
    const guard = window.setTimeout(
      () => finish({ fix: null, why: 'finding your location took too long' }),
      GEO_TIMEOUT_MS + 1500,
    )
    navigator.geolocation.getCurrentPosition(
      (position) => {
        window.clearTimeout(guard)
        const accuracy = position.coords.accuracy
        finish({
          fix: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            // The server widens the fence by this, so it must stay inside the
            // schema's 0…100000 bound rather than arriving as Infinity.
            accuracy_m: Number.isFinite(accuracy)
              ? Math.min(100000, Math.max(0, Math.round(accuracy)))
              : null,
          },
          why: null,
        })
      },
      (err) => {
        window.clearTimeout(guard)
        finish({ fix: null, why: GEO_REASON[err.code] ?? 'your location was not available' })
      },
      { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 60_000 },
    )
  })
}

/* -------------------------------------------------------------- the page -- */

interface PunchNotice {
  kind: 'in' | 'out'
  result: PunchResult
  geoWhy: string | null
}

export default function MyAttendance() {
  const { organization } = useAuth()
  const tz = organization?.timezone
  const today = orgToday(tz)
  const [month, setMonth] = useState(() => today.slice(0, 7))

  const todayQ = useQuery<AttendanceDay | null>('att-me-today', () =>
    api.get<AttendanceDay | null>('/attendance/me/today'),
  )
  /* Yesterday, only so a night shift can be closed. `punch_out` looks back one
     day for an open row (PUNCH_OUT_LOOKBACK_DAYS = 1), so a button that read
     only today's row would hide itself from exactly the people who work
     through midnight. */
  const yesterdayQ = useQuery<AttendanceDay[]>(`att-me-prev:${today}`, () =>
    api.get<AttendanceDay[]>(
      `/attendance/me?start=${addDays(today, -1)}&end=${addDays(today, -1)}`,
    ),
  )
  const settingsQ = useQuery<AttendanceSettingsPayload>('att-settings', () =>
    api.get<AttendanceSettingsPayload>('/attendance/settings'),
  )
  const officesQ = useQuery<OfficeLocation[]>('att-locations', () =>
    api.get<OfficeLocation[]>('/attendance/locations'),
  )

  const bounds = monthBounds(month)
  const monthQ = useQuery<AttendanceDay[]>(`att-me:${bounds.start}`, () =>
    api.get<AttendanceDay[]>(`/attendance/me?start=${bounds.start}&end=${bounds.end}`),
  )

  /* One query serves both the panel under a selected day and the history card
     below the calendar. `GET /regularization` takes its subject from the
     authenticated caller — there is no `user_id` to pass and nothing here that
     could widen it. Unbounded on purpose: a person files a handful of these a
     year, and the history is the durable record D-006 points at, so paging it
     by month would hide exactly the older request somebody is looking for. */
  const regQ = useQuery<RegRequest[]>('att-me-reg', () => api.get<RegRequest[]>('/regularization'))

  const [selected, setSelected] = useState<string | null>(null)

  function reloadAll() {
    todayQ.reload()
    yesterdayQ.reload()
    monthQ.reload()
  }

  /* A filed request changes `has_pending_regularization` on the day, so the
     calendar has to come back too — otherwise the cell keeps claiming there is
     nothing outstanding while the panel under it shows the request. */
  function reloadRegularization() {
    regQ.reload()
    reloadAll()
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">My attendance</h1>
          <p className="page-sub">
            Your punches, and how each day was classified.
          </p>
        </div>
      </div>

      <PunchCard
        today={todayQ.data}
        loading={todayQ.loading}
        error={todayQ.error}
        yesterday={yesterdayQ.data?.[0] ?? null}
        enforcement={settingsQ.data?.geofence_enforcement}
        offices={officesQ.data}
        timezone={tz}
        onPunched={reloadAll}
      />

      <MonthCalendar
        month={month}
        onMonth={setMonth}
        today={today}
        days={monthQ.data}
        loading={monthQ.loading}
        refetching={monthQ.refetching}
        error={monthQ.error}
        selected={selected}
        onSelect={setSelected}
        timezone={tz}
        requests={regQ.data}
        onFiled={reloadRegularization}
      />

      <MyRegularizations
        rows={regQ.data}
        loading={regQ.loading}
        refetching={regQ.refetching}
        error={regQ.error}
        timeZone={tz}
        onOpenDay={(date) => {
          setMonth(date.slice(0, 7))
          setSelected(date)
        }}
      />
    </div>
  )
}

/* ------------------------------------------------------------ punch card -- */

function PunchCard({
  today,
  loading,
  error,
  yesterday,
  enforcement,
  offices,
  timezone,
  onPunched,
}: {
  today: AttendanceDay | null | undefined
  loading: boolean
  error: string | null
  yesterday: AttendanceDay | null
  enforcement: Enforcement | undefined
  offices: OfficeLocation[] | undefined
  timezone: string | undefined
  onPunched: () => void
}) {
  /* Which button is in flight and how far along, so only that button changes
     its own label. `null` is idle. */
  const [phase, setPhase] = useState<{ kind: 'in' | 'out'; step: 'locating' | 'sending' } | null>(
    null,
  )
  const [notice, setNotice] = useState<PunchNotice | null>(null)
  const [failure, setFailure] = useState<(TypedFailure & { geoWhy: string | null }) | null>(null)
  const [note, setNote] = useState('')
  /* Office is the default because it is the common case, and because it is the
     strict one: a mode that relaxes the geofence should be chosen deliberately,
     not arrived at by leaving a form alone. */
  const [workMode, setWorkMode] = useState<WorkMode>('office')

  const busy = phase !== null
  const openNightShift =
    yesterday && yesterday.check_in_at && !yesterday.check_out_at ? yesterday : null
  const canPunchIn = !today?.check_in_at && !openNightShift
  const canPunchOut = Boolean((today?.check_in_at && !today.check_out_at) || openNightShift)
  const activeOffices = (offices ?? []).filter((o) => o.is_active)

  async function punch(kind: 'in' | 'out') {
    setNotice(null)
    setFailure(null)
    setPhase({ kind, step: 'locating' })
    const attempt = await requestFix()
    setPhase({ kind, step: 'sending' })
    try {
      const result = await api.post<PunchResult>(`/attendance/punch/${kind}`, {
        lat: attempt.fix?.lat ?? null,
        lng: attempt.fix?.lng ?? null,
        accuracy_m: attempt.fix?.accuracy_m ?? null,
        source: 'web',
        note: note.trim() || null,
        // Only on the way in. Punching out does not re-ask: the day's mode was
        // declared this morning and the server reads it off the row, so a
        // second question here could only contradict the first.
        work_mode: kind === 'in' ? workMode : null,
      })
      setNotice({ kind, result, geoWhy: attempt.why })
      setNote('')
      setWorkMode('office')
      onPunched()
    } catch (err) {
      setFailure({ ...typedError(err), geoWhy: attempt.why })
    } finally {
      setPhase(null)
    }
  }

  const label = (kind: 'in' | 'out', idle: string) => {
    if (phase?.kind !== kind) return idle
    return phase.step === 'locating' ? 'Finding your location…' : 'Recording…'
  }

  return (
    <section className="card" style={{ marginBottom: 14 }}>
      <div className="att-punch">
        <div>
          {loading ? (
            <Loading label="Reading today…" />
          ) : error ? (
            <ErrorNote>{error}</ErrorNote>
          ) : (
            <>
              <div className="att-clock">
                {today?.check_in_at
                  ? clockTime(today.check_in_at, timezone)
                  : openNightShift
                    ? clockTime(openNightShift.check_in_at, timezone)
                    : 'Not in yet'}
              </div>
              <div className="att-clock-sub">
                {openNightShift
                  ? `Checked in on ${openNightShift.date} — a night shift still open. Punching out closes that day, not today.`
                  : today?.check_in_at
                    ? `Checked in today${today.shift_name ? ` · ${today.shift_name} ${today.shift_start_time}–${today.shift_end_time}` : ''}`
                    : 'Punch in when you start. Your location is attached if the browser gives it, and the punch works either way.'}
              </div>

              {/* Asked before the buttons, and only while a check-in is still
                  possible: once the day is open the declaration is made and
                  re-offering it would imply it could still be changed here. */}
              {canPunchIn && (
                <WorkModePicker value={workMode} onChange={setWorkMode} disabled={busy} />
              )}

              <div className="att-actions">
                <button
                  className="btn btn-primary"
                  disabled={busy || !canPunchIn}
                  onClick={() => void punch('in')}
                >
                  {label('in', 'Punch in')}
                </button>
                <button
                  className="btn"
                  disabled={busy || !canPunchOut}
                  onClick={() => void punch('out')}
                >
                  {label('out', 'Punch out')}
                </button>
                {!canPunchIn && !canPunchOut && (
                  <span className="muted-sm">Today is closed. Nothing left to punch.</span>
                )}
              </div>

              <label className="setting" style={{ marginTop: 12 }}>
                Note (optional)
                <input
                  className="att-note-input"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={500}
                  placeholder="At the client's office today"
                  disabled={busy}
                />
              </label>
              <p className="setting-hint" style={{ marginTop: 6 }}>
                Attached to the punch. Cheaper for everyone than asking for a correction later.
              </p>
            </>
          )}
        </div>

        <div>
          <div className="att-pairs">
            <div>
              <div className="att-pair-label">Status today</div>
              <div className="att-pair-value">
                {today ? <StatusPill status={today.status} /> : <span>No record yet</span>}
              </div>
              <div className="att-pair-meta">
                {today ? 'Finalised after the day ends.' : 'A row appears at your first punch.'}
              </div>
            </div>
            <div>
              <div className="att-pair-label">Shift</div>
              <div className="att-pair-value">{today?.shift_name ?? 'Unassigned'}</div>
              <div className="att-pair-meta">
                {today?.shift_start_time
                  ? `${today.shift_start_time} – ${today.shift_end_time}`
                  : 'No shift on the rota for today, so nothing counts as late.'}
              </div>
            </div>
            <div>
              <div className="att-pair-label">Checked out</div>
              <div className="att-pair-value">{clockTime(today?.check_out_at ?? null, timezone)}</div>
            </div>
            <div>
              <div className="att-pair-label">Worked</div>
              <div className="att-pair-value">{hm(today?.worked_minutes ?? 0)}</div>
              <div className="att-pair-meta">Counted when you punch out.</div>
            </div>
          </div>

          {today && <div style={{ marginTop: 10 }}><DayFlags day={today} /></div>}

          <div className="att-offices">
            {enforcement === 'required' && (
              <p style={{ margin: '0 0 6px' }}>
                <b>This organisation requires a location to punch.</b> If your browser blocks it,
                the punch is refused and you will need a regularisation — so allow location access
                when asked.
              </p>
            )}
            {enforcement === 'off' && (
              <p style={{ margin: '0 0 6px' }}>Location checks are off here. Nothing is measured.</p>
            )}
            {activeOffices.length > 0 ? (
              <>
                <b>Office locations:</b>{' '}
                {activeOffices.map((o) => `${o.name} (${o.radius_m} m)`).join(' · ')}
              </>
            ) : (
              enforcement !== 'off' && (
                <>No office locations are set up, so no punch can be verified against one.</>
              )
            )}
          </div>
        </div>
      </div>

      {notice && (
        <div style={{ marginTop: 14 }}>
          <PunchVerdict notice={notice} timezone={timezone} />
        </div>
      )}
      {failure && (
        <div style={{ marginTop: 14 }}>
          <ErrorNote>
            {failure.message}
            {failure.geoWhy && failure.reason === 'location_required' && (
              <div className="att-verdict-detail">
                Your browser reported that {failure.geoWhy}.
              </div>
            )}
          </ErrorNote>
        </div>
      )}
    </section>
  )
}

/**
 * What actually happened, said honestly.
 *
 * An unverified punch is **accepted and flagged**, so this is never styled as
 * an error. The three cases it must keep apart: verified at an office; recorded
 * with no location at all; recorded outside the fence at a measured distance.
 */
function PunchVerdict({ notice, timezone }: { notice: PunchNotice; timezone: string | undefined }) {
  const { kind, result, geoWhy } = notice
  const stamp = clockTime(
    kind === 'in' ? result.record.check_in_at : result.record.check_out_at,
    timezone,
  )
  const verb = kind === 'in' ? 'Punched in' : 'Punched out'

  if (result.enforcement === 'off') {
    return (
      <div className="att-verdict att-verdict-plain">
        <b>
          {verb} at {stamp}.
        </b>{' '}
        Location checks are switched off for this organisation, so nothing was measured.
        {kind === 'out' && result.record.worked_minutes > 0 && (
          <div className="att-verdict-detail">
            Worked today: {hm(result.record.worked_minutes)}.
          </div>
        )}
      </div>
    )
  }

  if (result.is_geo_verified) {
    return (
      <div className="att-verdict att-verdict-ok">
        <b>
          {verb} at {stamp}
          {result.nearest_office_name ? ` — verified at ${result.nearest_office_name}` : ' — verified'}.
        </b>
        {kind === 'out' && result.record.worked_minutes > 0 && (
          <div className="att-verdict-detail">
            Worked today: {hm(result.record.worked_minutes)}.
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="att-verdict att-verdict-flag">
      <b>
        {verb} at {stamp}. Recorded, but not verified against an office.
      </b>
      <div className="att-verdict-detail">
        {geoWhy
          ? `Your location was not attached because ${geoWhy}. That is fine — the punch counts, it is simply marked unverified.`
          : result.distance_m != null
            ? `You were about ${result.distance_m} m from ${result.nearest_office_name ?? 'the nearest office'}, outside its area. The punch counts and is flagged; your manager may ask about it.`
            : 'There is no active office location to check against, so nothing could be verified.'}
        {kind === 'out' && result.record.worked_minutes > 0 && (
          <> Worked today: {hm(result.record.worked_minutes)}.</>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- calendar -- */

function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number)
  return { start: isoDate(new Date(y, m - 1, 1)), end: isoDate(new Date(y, m, 0)) }
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return isoDate(d).slice(0, 7)
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function MonthCalendar({
  month,
  onMonth,
  today,
  days,
  loading,
  refetching,
  error,
  selected,
  onSelect,
  timezone,
  requests,
  onFiled,
}: {
  month: string
  onMonth: (m: string) => void
  today: string
  days: AttendanceDay[] | undefined
  loading: boolean
  refetching: boolean
  error: string | null
  selected: string | null
  onSelect: (iso: string | null) => void
  timezone: string | undefined
  requests: RegRequest[] | undefined
  onFiled: () => void
}) {
  const byDate = useMemo(() => {
    const map = new Map<string, AttendanceDay>()
    for (const day of days ?? []) map.set(day.date, day)
    return map
  }, [days])

  const summary = useMemo(() => {
    const counts: Record<string, number> = {}
    let worked = 0
    let late = 0
    let missing = 0
    for (const day of days ?? []) {
      counts[day.status] = (counts[day.status] ?? 0) + 1
      worked += day.worked_minutes
      if (day.is_late) late += 1
      if (day.is_missing_punch) missing += 1
    }
    return { counts, worked, late, missing }
  }, [days])

  const { start, end } = monthBounds(month)
  const [firstY, firstM] = start.split('-').map(Number)
  const leading = (new Date(firstY, firstM - 1, 1).getDay() + 6) % 7
  const total = Number(end.split('-')[2])
  const cells: Array<string | null> = [
    ...Array<null>(leading).fill(null),
    ...Array.from({ length: total }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`),
  ]

  const selectedDay = selected ? (byDate.get(selected) ?? null) : null

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Calendar</h2>
        <div className="att-cal-nav">
          <button className="btn btn-sm" onClick={() => onMonth(shiftMonth(month, -1))} aria-label="Previous month">
            ←
          </button>
          <span className="att-cal-month">{monthLabel(month)}</span>
          <button className="btn btn-sm" onClick={() => onMonth(shiftMonth(month, 1))} aria-label="Next month">
            →
          </button>
          <button
            className="btn btn-sm"
            onClick={() => onMonth(today.slice(0, 7))}
            disabled={month === today.slice(0, 7)}
          >
            This month
          </button>
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !days && <Loading />}

      {days && (
        <div className={refetching ? 'refetching' : undefined}>
          <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
            <StatTile label="Present" value={String(summary.counts.present ?? 0)} accent="var(--status-good)" />
            <StatTile label="Absent" value={String(summary.counts.absent ?? 0)} accent={summary.counts.absent ? 'var(--status-critical)' : undefined} />
            <StatTile label="Half days" value={String(summary.counts.half_day ?? 0)} />
            <StatTile label="On leave" value={String(summary.counts.on_leave ?? 0)} />
            <StatTile
              label="Worked"
              value={hm(summary.worked)}
              meta={`${summary.late} late · ${summary.missing} missing a check-out`}
            />
          </div>

          {/* The grid renders even with nothing in it, rather than being
              replaced by the note: an empty month is precisely when somebody
              needs to open a day and ask for it to be corrected, and a page
              that swaps the calendar for a sentence takes that away. */}
          {days.length === 0 && (
            <Empty>
              No attendance recorded in {monthLabel(month)}. Days appear here once you punch, and
              the nightly job fills in absences, weekly offs and holidays after each day ends. You
              can still open a past day below to ask for it to be corrected.
            </Empty>
          )}
          {
            <>
              <div className="att-cal-grid" role="grid" aria-label={`Attendance for ${monthLabel(month)}`}>
                {DOW.map((label) => (
                  <div key={label} className="att-cal-dow">
                    {label}
                  </div>
                ))}
                {cells.map((iso, index) => {
                  if (iso === null) return <div key={`blank-${index}`} className="att-cell att-cell-blank" />
                  const day = byDate.get(iso)
                  const number = Number(iso.slice(8))
                  const classes = [
                    'att-cell',
                    day ? `att-${day.status}` : 'att-cell-none',
                    iso === today ? 'att-cell-today' : '',
                    iso === selected ? 'att-cell-on' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')
                  /* A day with no row is still selectable if it is in the past:
                     "I was on a client site all Tuesday and never punched" is
                     not an edge case, it is the case regularization exists for
                     (D-007), and before the nightly job runs there is no row to
                     click. A future day genuinely has nothing to say. */
                  const openable = Boolean(day) || iso <= today
                  return (
                    <button
                      key={iso}
                      type="button"
                      className={classes}
                      disabled={!openable}
                      aria-pressed={iso === selected}
                      onClick={() => onSelect(iso === selected ? null : iso)}
                      title={day ? `${longDate(iso)} — ${STATUS[day.status]?.label ?? day.status}` : longDate(iso)}
                    >
                      <span className="att-daynum">{number}</span>
                      {day && <span className="att-cell-label">{STATUS[day.status]?.short ?? day.status}</span>}
                      {day && <DayFlags day={day} />}
                      {day?.check_in_at && (
                        <span className="att-cell-time">
                          {clockTime(day.check_in_at, timezone)}
                          {day.check_out_at ? `–${clockTime(day.check_out_at, timezone)}` : ''}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>

              <div className="att-legend">
                {(Object.keys(STATUS) as AttendanceStatus[]).map((key) => (
                  <span key={key} className="att-legend-item">
                    <span className="att-swatch" style={{ background: STATUS[key].color }} />
                    {STATUS[key].label}
                  </span>
                ))}
                <span className="att-legend-item">
                  <span className="att-swatch" style={{ background: 'transparent' }} />
                  No record yet
                </span>
              </div>
            </>
          }

          {selected &&
            (selectedDay ? (
              <DayDetail day={selectedDay} timezone={timezone} onClose={() => onSelect(null)}>
                <DayRegularization
                  key={selected}
                  date={selected}
                  day={selectedDay}
                  timeZone={timezone}
                  requests={requests}
                  onFiled={onFiled}
                  onBehalf={null}
                />
              </DayDetail>
            ) : (
              /* No attendance row at all — nothing was ever punched and the
                 nightly job has not classified the day yet. Approval creates
                 the row (D-007), so this is a perfectly fileable day; there is
                 simply no record to lay out above the form. */
              <div className="att-detail">
                <div className="att-detail-head">
                  <div className="att-detail-title">{longDate(selected)}</div>
                  <button className="btn btn-sm" onClick={() => onSelect(null)}>
                    Close
                  </button>
                </div>
                <p className="setting-hint" style={{ marginTop: 0 }}>
                  Nothing is recorded for this day — no punch, and the nightly job has not
                  classified it yet. An approved correction creates the record from scratch.
                </p>
                <DayRegularization
                  key={selected}
                  date={selected}
                  day={null}
                  timeZone={timezone}
                  requests={requests}
                  onFiled={onFiled}
                  onBehalf={null}
                />
              </div>
            ))}
        </div>
      )}
    </section>
  )
}

/**
 * One day, opened out.
 *
 * `children` is the slot the regularization block hangs off — the correction
 * form and that day's request history. It is a slot rather than a prop bundle
 * so `TeamAttendance` can mount the same detail box with the *on-behalf* form
 * inside it (D-008) without this component learning anything about
 * regularization, or about who is allowed to file one.
 */
export function DayDetail({
  day,
  timezone,
  onClose,
  children,
}: {
  day: AttendanceDay
  timezone: string | undefined
  onClose?: () => void
  children?: ReactNode
}) {
  return (
    <div className="att-detail">
      <div className="att-detail-head">
        <div className="att-detail-title">
          {day.user_name ? `${day.user_name} · ` : ''}
          {longDate(day.date)}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <StatusPill status={day.status} />
          {onClose && (
            <button className="btn btn-sm" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>

      <div className="att-detail-grid">
        <div>
          <div className="att-pair-label">Checked in</div>
          <div className="att-pair-value">{clockTime(day.check_in_at, timezone)}</div>
          <div className="att-pair-meta">
            {/* A corrected punch must never read as GPS-confirmed. The service
                clears the coordinates on the half it moves, so "no location
                attached" would be technically true and thoroughly misleading —
                it sounds like the employee's browser refused, not like a human
                decided this time. */}
            {day.check_in_at
              ? day.check_in_source === 'regularized'
                ? 'Set by an approved correction — no location evidence'
                : day.is_geo_verified_in
                  ? 'Verified at an office'
                  : day.check_in_distance_m != null
                    ? `About ${day.check_in_distance_m} m from the nearest office`
                    : 'No location attached'
              : '—'}
            {day.check_in_source ? ` · ${day.check_in_source}` : ''}
          </div>
        </div>
        <div>
          <div className="att-pair-label">Checked out</div>
          <div className="att-pair-value">{clockTime(day.check_out_at, timezone)}</div>
          <div className="att-pair-meta">
            {day.check_out_at
              ? day.check_out_source === 'regularized'
                ? 'Set by an approved correction — no location evidence'
                : day.is_geo_verified_out
                  ? 'Verified at an office'
                  : day.check_out_distance_m != null
                    ? `About ${day.check_out_distance_m} m from the nearest office`
                    : 'No location attached'
              : 'Still open'}
            {day.check_out_source ? ` · ${day.check_out_source}` : ''}
          </div>
        </div>
        <div>
          <div className="att-pair-label">Worked</div>
          <div className="att-pair-value">{hm(day.worked_minutes)}</div>
        </div>
        <div>
          <div className="att-pair-label">Shift that day</div>
          <div className="att-pair-value">{day.shift_name ?? 'Unassigned'}</div>
          <div className="att-pair-meta">
            {day.shift_start_time ? `${day.shift_start_time} – ${day.shift_end_time}` : 'Nothing to be late for'}
          </div>
        </div>
        <div>
          <div className="att-pair-label">Punctuality</div>
          <div className="att-pair-value">
            {day.is_late ? `${day.late_minutes}m late` : day.check_in_at ? 'On time' : '—'}
          </div>
          <div className="att-pair-meta">
            {day.is_early_out ? `Left ${day.early_out_minutes}m early` : ''}
          </div>
        </div>
        <div>
          <div className="att-pair-label">Corrections</div>
          <div className="att-pair-value">
            {day.is_regularized ? 'Regularised' : day.has_pending_regularization ? 'Request pending' : 'None'}
          </div>
          <div className="att-pair-meta">
            {day.is_regularized
              ? 'Frozen — the nightly job will not revisit this day.'
              : day.has_pending_regularization
                ? 'Nothing changes until it is decided.'
                : ''}
          </div>
        </div>
      </div>

      {children}
    </div>
  )
}
