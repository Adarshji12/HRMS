/* Attendance regularization — the correction request, its history, and the
   manager's review queue.

   Kept beside the three attendance pages rather than inside one of them because
   both `MyAttendance` (file a correction, read my own history) and
   `TeamAttendance` (decide someone else's, file on their behalf) need the same
   vocabulary, and the alternative was TeamAttendance importing a review queue
   out of a file called "MyAttendance".

   Five server truths this file is built around. Getting any of them wrong here
   produces a screen that lies rather than one that merely looks wrong.

   1. **`RegularizationIn` carries no identity.** The subject and the author are
      both the authenticated caller. Filing for somebody else is a *different
      endpoint* — `POST /regularization/on-behalf/{user_id}` — with the subject
      in the path and its own permission. So this file never puts a `user_id` in
      a request body, and the on-behalf control is only rendered for a caller
      holding `can_approve_regularization`.

   2. **There is one decision endpoint.** `POST /{id}/review` with
      `status: 'approved' | 'rejected'`, not `/approve` and `/reject`. A note is
      optional on approval and required on rejection — the service refuses a
      blank one with `note_required`, and we refuse it here first so the manager
      does not have to lose their typing to find out.

   3. **A second *pending* request for the same day is refused by a partial
      unique index** (D-005/D-027) as a typed 409, `pending_request_exists`.
      Only a pending one blocks. Re-filing after a rejection is allowed, and so
      is correcting a day that was already corrected (D-006) — so the form is
      never disabled merely because a request exists for the date.

   4. **`attendance_records.regularization_id` is a convenience pointer, not
      history** (D-006). After a second approval it names only the latest one.
      The durable record is `regularization_requests` read by `(user_id, date)`,
      which is exactly what this file renders — including marking the earlier
      approved request for a date as superseded, because otherwise two
      contradictory "approved" rows sit side by side with nothing to say which
      one the record currently reflects.

   5. **Approval clears geo-verification on the half it corrects.** A latitude
      captured at 09:02 is not evidence for a check-in a manager moved to 08:30.
      Nothing here presents a corrected punch as verified, and both the approval
      confirmation and the history say so in words.

   The cycle with `MyAttendance.tsx` (it imports the components below; this
   imports `hm`/`longDate`/`orgToday`/`typedError` from it) is safe and
   deliberate: everything crossing the boundary is a hoisted function
   declaration or an erased type, so neither module reads the other's bindings
   while a module body is still evaluating. */

import { useMemo, useState, type ReactNode } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { useAuth } from '../../../lib/auth'
import { dateTime } from '../../../lib/format'
import { Empty, EmptyState, ErrorNote, Identity, Loading, StatTile } from '../../../components/ui'
import {
  hm,
  longDate,
  orgToday,
  typedError,
  type AttendanceDay,
  type TypedFailure,
} from './MyAttendance'

/* ------------------------------------------------------------------ types --
   Page-local, mirroring app/schemas/regularization.py exactly. Field names are
   the server's — `reviewed_by_user_id` and `created_by_user_id`, not the
   spec's `reviewed_by` shorthand (D-008). */

export type RegStatus = 'pending' | 'approved' | 'rejected'

/** `RegularizationOut`. The three `*_name` fields are derived server-side so no
    client ever joins; `reviewer_name` is null on a pending row *and* on a
    decided row whose reviewer has left, which is why every decided row renders
    `reviewed_at` and not only the name (D-008). */
export interface RegRequest {
  id: string
  org_id: string
  user_id: string
  date: string
  requested_check_in: string | null
  requested_check_out: string | null
  reason: string
  status: string
  created_by_user_id: string | null
  reviewed_by_user_id: string | null
  reviewed_at: string | null
  review_note: string | null
  created_at: string
  user_name: string | null
  reviewer_name: string | null
  created_by_name: string | null
}

/* ---------------------------------------------------------------- time -- */

/**
 * Parse a server instant.
 *
 * SQLite drops tzinfo, so some timestamps arrive as "2026-08-18T06:23:53" with
 * no marker. `new Date()` reads a marker-less string as *browser-local*, which
 * silently shifts it by the viewer's offset. `lib/format.ts` normalises this
 * for its own formatters but does not export the helper, and it is lead-owned.
 */
function instant(iso: string): Date {
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`)
}

/**
 * How far the given zone is ahead of UTC at that moment, in milliseconds.
 *
 * Formatting the instant *into* the zone and reading the wall clock back is the
 * only way to get this from `Intl` — there is no offset accessor — and it is
 * correct across DST because the answer is asked at a specific instant.
 */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  const wall = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  )
  return wall - utcMs
}

/**
 * "08:30 on 2026-08-20, in the organisation's timezone" → a UTC instant.
 *
 * This is the whole reason the form cannot just concatenate the date and the
 * time and post it. The server validates that the requested timestamps fall on
 * the day being corrected **in `org.timezone`** (`_check_times_belong_to_day`),
 * so a viewer in another zone typing 08:30 must not send 08:30 *their* time —
 * that lands on the wrong local date and comes back as `check_in_off_day`.
 *
 * Two passes: the first offset is looked up at the wall time read as if it were
 * UTC, the second at the instant that produced. That converges on every real
 * zone and is what fixes the hour either side of a DST transition.
 */
export function zonedWallToISO(
  dateISO: string,
  hhmm: string,
  plusDays: number,
  timeZone: string | undefined,
): string | null {
  const [y, m, d] = dateISO.split('-').map(Number)
  const [hh, mi] = hhmm.split(':').map(Number)
  if (![y, m, d, hh, mi].every((n) => Number.isFinite(n))) return null
  const wall = Date.UTC(y, m - 1, d + plusDays, hh, mi)
  if (!timeZone) return new Date(y, m - 1, d + plusDays, hh, mi).toISOString()
  try {
    const first = wall - zoneOffsetMs(wall, timeZone)
    return new Date(wall - zoneOffsetMs(first, timeZone)).toISOString()
  } catch {
    // An unknown zone name would otherwise take the whole form down.
    return new Date(y, m - 1, d + plusDays, hh, mi).toISOString()
  }
}

/** "08:30" in the organisation's zone — the value an `<input type="time">` wants. */
export function zonedHHMM(iso: string | null | undefined, timeZone: string | undefined): string {
  if (!iso) return ''
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || undefined,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).format(instant(iso))
  } catch {
    return ''
  }
}

/** The calendar date an instant falls on in the organisation's zone. */
function zonedDate(iso: string, timeZone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant(iso))
  } catch {
    return ''
  }
}

/** "3d ago" from a server instant, normalised. `format.relativeTime` reads a
    marker-less timestamp as local and would report a queue item as arriving in
    the future for anyone east of UTC. */
function since(iso: string | null): string {
  if (!iso) return '—'
  const seconds = (Date.now() - instant(iso).getTime()) / 1000
  if (seconds < 90) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

function minutesBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null
  return Math.round((instant(to).getTime() - instant(from).getTime()) / 60_000)
}

/* --------------------------------------------------------------- labels -- */

const REG_STATUS: Record<string, { label: string; short: string; color: string }> = {
  pending: { label: 'Awaiting a decision', short: 'Pending', color: 'var(--status-warn)' },
  approved: { label: 'Approved', short: 'Approved', color: 'var(--status-good)' },
  rejected: { label: 'Rejected', short: 'Rejected', color: 'var(--status-critical)' },
}

export function RegStatusPill({ status }: { status: string }) {
  const meta = REG_STATUS[status] ?? { label: status, color: 'var(--text-muted)' }
  return (
    <span className="att-status">
      <span className="att-status-dot" style={{ background: meta.color }} />
      {meta.label}
    </span>
  )
}

/** What was asked for, in the organisation's clock. Either half may be absent —
    the usual request is a forgotten check-out, and the schema deliberately does
    not force the employee to restate a punch that was already right. */
export function askedLabel(row: RegRequest, timeZone: string | undefined): string {
  const parts: string[] = []
  if (row.requested_check_in) parts.push(`in ${zonedHHMM(row.requested_check_in, timeZone)}`)
  if (row.requested_check_out) {
    const rolls = zonedDate(row.requested_check_out, timeZone) !== row.date
    parts.push(`out ${zonedHHMM(row.requested_check_out, timeZone)}${rolls ? ' next day' : ''}`)
  }
  return parts.join(' · ') || 'no change'
}

/** "Filed by Priya" — but only when that is not the subject themselves.
    `created_by_user_id` stores the employee's own id on a self-filed request
    rather than NULL, so printing it unconditionally puts a redundant
    "filed by Asha" under every row that already says "Asha". */
export function filerLabel(row: RegRequest): string | null {
  if (!row.created_by_user_id || row.created_by_user_id === row.user_id) return null
  return row.created_by_name ?? 'someone else'
}

/**
 * Which approved requests a later approval has overtaken.
 *
 * D-006 allows correcting an already-corrected day, and the attendance row then
 * points only at the newest approved request. Without this, an employee reading
 * their history sees two rows both marked "approved" for one date, contradicting
 * each other, with nothing to say which one the record actually reflects.
 * Computed from `(user_id, date)` over the requests themselves, which is the
 * only place D-006 permits history to be read from.
 */
function supersededIds(rows: RegRequest[]): Map<string, RegRequest> {
  const latest = new Map<string, RegRequest>()
  for (const row of rows) {
    if (row.status !== 'approved') continue
    const key = `${row.user_id}|${row.date}`
    const held = latest.get(key)
    const stamp = row.reviewed_at ?? row.created_at
    const heldStamp = held ? (held.reviewed_at ?? held.created_at) : ''
    if (!held || stamp > heldStamp) latest.set(key, row)
  }
  const out = new Map<string, RegRequest>()
  for (const row of rows) {
    if (row.status !== 'approved') continue
    const winner = latest.get(`${row.user_id}|${row.date}`)
    if (winner && winner.id !== row.id) out.set(row.id, winner)
  }
  return out
}

/* ------------------------------------------------------------ the outcome --
   "What was asked for versus what was granted", which for this feature is the
   only interesting column: an approval writes the requested times verbatim, a
   rejection writes nothing at all, and the difference between those two is what
   an employee comes to this screen to establish. */

function Outcome({
  row,
  timeZone,
  supersededBy,
}: {
  row: RegRequest
  timeZone: string | undefined
  supersededBy: RegRequest | undefined
}) {
  if (row.status === 'pending') {
    return (
      <div className="att-reg-outcome">
        <div>Nothing has changed yet. The record still reads as it did.</div>
        <div className="att-reg-meta">Filed {since(row.created_at)} · {dateTime(row.created_at)}</div>
      </div>
    )
  }

  if (row.status === 'rejected') {
    return (
      <div className="att-reg-outcome">
        <div>
          <b>Nothing was changed.</b> A rejection touches the attendance record not at all — the
          missing punch, the absence, the unverified geofence all stand exactly as they were.
        </div>
        {row.review_note && <div className="att-reg-note">“{row.review_note}”</div>}
        <div className="att-reg-meta">
          {row.reviewer_name ? `${row.reviewer_name} · ` : ''}
          {dateTime(row.reviewed_at)}
          {!row.reviewer_name && row.reviewed_at ? ' (reviewer no longer on the system)' : ''}
        </div>
        <div className="att-reg-meta">You can file a corrected request for the same day.</div>
      </div>
    )
  }

  return (
    <div className="att-reg-outcome">
      <div>
        <b>Written to the record as {askedLabel(row, timeZone)}.</b> The day was re-classified at
        that moment, with holidays and weekly offs still outranking a worked day.
      </div>
      {row.review_note && <div className="att-reg-note">“{row.review_note}”</div>}
      <div className="att-reg-meta">
        {row.reviewer_name ? `${row.reviewer_name} · ` : ''}
        {dateTime(row.reviewed_at)}
        {!row.reviewer_name && row.reviewed_at ? ' (reviewer no longer on the system)' : ''}
      </div>
      {supersededBy ? (
        <div className="att-reg-meta att-reg-super">
          Replaced by a later correction approved on {dateTime(supersededBy.reviewed_at)}. The
          record now reads {askedLabel(supersededBy, timeZone)}.
        </div>
      ) : (
        <div className="att-reg-meta">
          The corrected punch carries <b>no location evidence</b> — a coordinate recorded at the
          original time is not proof of a time a person decided. The nightly job will not touch
          this day again (D-028), which is why it stopped changing.
        </div>
      )}
    </div>
  )
}

/* ----------------------------------------------------------------- form -- */

interface Draft {
  wantIn: boolean
  wantOut: boolean
  inTime: string
  outTime: string
  outNextDay: boolean
  reason: string
}

function firstDraft(day: AttendanceDay | null | undefined, timeZone: string | undefined): Draft {
  const inAt = zonedHHMM(day?.check_in_at, timeZone)
  const outAt = zonedHHMM(day?.check_out_at, timeZone)
  return {
    // Default to the halves that are *missing*, because that is what a
    // correction is nearly always about. Ticking a half that is already right
    // is how an employee accidentally asks to have a good punch overwritten.
    wantIn: !day?.check_in_at,
    wantOut: !day?.check_out_at,
    inTime: inAt || day?.shift_start_time?.slice(0, 5) || '09:00',
    outTime: outAt || day?.shift_end_time?.slice(0, 5) || '18:00',
    outNextDay: false,
    reason: '',
  }
}

/**
 * Ask for one day to be corrected.
 *
 * Every rule mirrored here is also enforced by the server; the point of
 * mirroring is that the employee finds out before losing three sentences of
 * typing, not that the check is trusted. The one refusal deliberately left to
 * the server is the duplicate-pending 409, because that one is a race the
 * client genuinely cannot win (D-005).
 */
export function RegularizationForm({
  date,
  day,
  timeZone,
  onBehalf,
  onFiled,
}: {
  date: string
  day: AttendanceDay | null | undefined
  timeZone: string | undefined
  /** Present only for a caller holding `can_approve_regularization`, and only
      when they are filing about somebody other than themselves (D-008). */
  onBehalf: { userId: string; name: string } | null
  onFiled: () => void
}) {
  const [draft, setDraft] = useState<Draft>(() => firstDraft(day, timeZone))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<TypedFailure | null>(null)
  const set = <K extends keyof Draft,>(key: K, value: Draft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }))

  const startISO = draft.wantIn ? zonedWallToISO(date, draft.inTime, 0, timeZone) : null
  const endISO = draft.wantOut
    ? zonedWallToISO(date, draft.outTime, draft.outNextDay ? 1 : 0, timeZone)
    : null

  const problems: string[] = []
  if (!draft.wantIn && !draft.wantOut) {
    problems.push('Tick at least one punch. A request that changes nothing cannot be approved.')
  }
  if (!draft.reason.trim()) {
    problems.push('Give a reason — the manager deciding this has nothing else to go on.')
  }
  if (startISO && endISO && endISO <= startISO) {
    problems.push(
      draft.outNextDay
        ? 'The check-out is still not after the check-in.'
        : 'The check-out is earlier than the check-in. If this was a night shift, tick “next morning”.',
    )
  }

  const span = minutesBetween(startISO, endISO)

  async function submit() {
    setBusy(true)
    setFailure(null)
    try {
      // No identity in this body, ever. Filing for somebody else is the
      // on-behalf endpoint with the subject in the path.
      const path = onBehalf ? `/regularization/on-behalf/${onBehalf.userId}` : '/regularization'
      await api.post<RegRequest>(path, {
        date,
        requested_check_in: startISO,
        requested_check_out: endISO,
        reason: draft.reason.trim(),
      })
      setDraft(firstDraft(day, timeZone))
      onFiled()
    } catch (err) {
      setFailure(typedError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="att-reg-form">
      <div className="att-reg-fields">
        <div className="att-reg-field">
          <label className="att-reg-check">
            <input
              type="checkbox"
              checked={draft.wantIn}
              onChange={(e) => set('wantIn', e.target.checked)}
              disabled={busy}
            />
            Correct the check-in
          </label>
          <input
            type="time"
            value={draft.inTime}
            onChange={(e) => set('inTime', e.target.value)}
            disabled={busy || !draft.wantIn}
            aria-label="Requested check-in time"
          />
          <div className="setting-hint">
            {day?.check_in_at
              ? `Currently ${zonedHHMM(day.check_in_at, timeZone)}. Leave this unticked if it is right — approval overwrites whatever it touches.`
              : 'No check-in was ever recorded for this day.'}
          </div>
        </div>

        <div className="att-reg-field">
          <label className="att-reg-check">
            <input
              type="checkbox"
              checked={draft.wantOut}
              onChange={(e) => set('wantOut', e.target.checked)}
              disabled={busy}
            />
            Correct the check-out
          </label>
          <input
            type="time"
            value={draft.outTime}
            onChange={(e) => set('outTime', e.target.value)}
            disabled={busy || !draft.wantOut}
            aria-label="Requested check-out time"
          />
          <label className="att-reg-check att-reg-check-sm">
            <input
              type="checkbox"
              checked={draft.outNextDay}
              onChange={(e) => set('outNextDay', e.target.checked)}
              disabled={busy || !draft.wantOut}
            />
            …the next morning (night shift)
          </label>
          <div className="setting-hint">
            {day?.check_out_at
              ? `Currently ${zonedHHMM(day.check_out_at, timeZone)}.`
              : 'No check-out was recorded, so this day never closed.'}
          </div>
        </div>
      </div>

      <label className="setting" style={{ marginTop: 12 }}>
        Why
        <textarea
          className="set-textarea"
          rows={3}
          maxLength={2000}
          value={draft.reason}
          onChange={(e) => set('reason', e.target.value)}
          disabled={busy}
          placeholder={
            onBehalf
              ? 'Laptop was with IT all morning; confirmed with the site register.'
              : 'Was at the client site from 08:30 and could not reach the punch screen.'
          }
        />
      </label>
      <p className="setting-hint">
        This ends up on the audit record beside whatever the manager decides, so it is worth a
        sentence rather than “forgot”.
      </p>

      {/* What will actually be sent, in the organisation's clock — not the
          viewer's. The server validates these instants against `org.timezone`,
          so showing the browser's rendering of them would be showing something
          other than the thing being submitted. */}
      <div className="att-reg-preview">
        Asking for <b>{startISO || endISO ? previewLabel(startISO, endISO, date, timeZone) : '—'}</b>{' '}
        on {longDate(date)}
        {span !== null && span > 0 ? ` · ${hm(span)} worked` : ''}
        {timeZone ? ` · times are ${timeZone}` : ''}
      </div>

      {problems.length > 0 && (
        <ul className="att-reg-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      {failure && (
        <div style={{ marginTop: 10 }}>
          <ErrorNote>
            {failure.message}
            {failure.reason === 'pending_request_exists' && (
              <div className="att-verdict-detail">
                Only a <b>pending</b> request blocks a new one — a rejected or approved day can
                always be filed against again. The open one is listed above.
              </div>
            )}
          </ErrorNote>
        </div>
      )}

      <div className="att-form-actions">
        <button
          className="btn btn-primary"
          disabled={busy || problems.length > 0}
          onClick={() => void submit()}
        >
          {busy ? 'Filing…' : onBehalf ? `File for ${onBehalf.name}` : 'Ask for this correction'}
        </button>
        {onBehalf && (
          <span className="muted-sm">
            Recorded as filed by you on {onBehalf.name}’s behalf, not as theirs.
          </span>
        )}
      </div>
    </div>
  )
}

function previewLabel(
  startISO: string | null,
  endISO: string | null,
  date: string,
  timeZone: string | undefined,
): string {
  const parts: string[] = []
  if (startISO) parts.push(`in ${zonedHHMM(startISO, timeZone)}`)
  if (endISO) {
    const rolls = zonedDate(endISO, timeZone) !== date
    parts.push(`out ${zonedHHMM(endISO, timeZone)}${rolls ? ' next day' : ''}`)
  }
  return parts.join(' · ')
}

/* ------------------------------------------------------------ day panel -- */

/** One request, rendered compactly under a day. */
function RequestLine({
  row,
  timeZone,
  supersededBy,
}: {
  row: RegRequest
  timeZone: string | undefined
  supersededBy: RegRequest | undefined
}) {
  const filer = filerLabel(row)
  return (
    <div className="att-reg-item">
      <div className="att-reg-item-head">
        <RegStatusPill status={row.status} />
        <span className="att-reg-asked">{askedLabel(row, timeZone)}</span>
        {filer && <span className="att-reg-meta">filed by {filer}</span>}
      </div>
      <div className="att-reg-note">“{row.reason}”</div>
      <Outcome row={row} timeZone={timeZone} supersededBy={supersededBy} />
    </div>
  )
}

/**
 * The regularization block that hangs off `DayDetail` — history for that one
 * date, then the form.
 *
 * Mount it with `key={date}` so switching days resets the draft rather than
 * carrying yesterday's half-typed reason onto today.
 */
export function DayRegularization({
  date,
  day,
  timeZone,
  requests,
  onFiled,
  onBehalf,
  canFile = true,
}: {
  date: string
  day: AttendanceDay | null | undefined
  timeZone: string | undefined
  /** The subject's whole history; filtered to this date here so the caller
      needs only one query for the page. */
  requests: RegRequest[] | undefined
  onFiled: () => void
  onBehalf: { userId: string; name: string } | null
  /**
   * Whether this viewer may file *about this subject at all*.
   *
   * Separate from `onBehalf` on purpose, and the separation is load-bearing: a
   * team viewer without `can_approve_regularization` opening a colleague's day
   * has `onBehalf` null because they cannot use the privileged endpoint — and
   * with a single prop the form would quietly fall back to `POST
   * /regularization`, which files against *the viewer's own* attendance for
   * that date. That is not a degraded experience, it is the wrong record.
   */
  canFile?: boolean
}) {
  const [open, setOpen] = useState(false)
  const mine = useMemo(
    () => (requests ?? []).filter((row) => row.date === date),
    [requests, date],
  )
  const superseded = useMemo(() => supersededIds(requests ?? []), [requests])
  const pending = mine.find((row) => row.status === 'pending') ?? null
  const isFuture = date > orgToday(timeZone)

  return (
    <div className="att-reg">
      <div className="att-reg-head">
        <h3 className="att-reg-title">Corrections</h3>
        {canFile && !pending && !isFuture && (
          <button className="btn btn-sm" onClick={() => setOpen((v) => !v)}>
            {open ? 'Cancel' : onBehalf ? 'File a correction' : 'Ask for a correction'}
          </button>
        )}
      </div>

      {mine.length > 0 ? (
        <div className="att-reg-list">
          {mine.map((row) => (
            <RequestLine
              key={row.id}
              row={row}
              timeZone={timeZone}
              supersededBy={superseded.get(row.id)}
            />
          ))}
        </div>
      ) : (
        <p className="setting-hint" style={{ margin: '0 0 10px' }}>
          {isFuture
            ? 'This day has not happened yet, so there is nothing to correct.'
            : 'No correction has ever been asked for on this day.'}
        </p>
      )}

      {!canFile ? (
        <p className="setting-hint" style={{ margin: 0 }}>
          Filing a correction on somebody else’s behalf is a separate permission from seeing their
          attendance. An administrator can switch it on for you on the employee record; until
          then, they file it themselves from their own calendar.
        </p>
      ) : pending ? (
        /* D-005/D-027: the partial unique index permits exactly one *pending*
           request per person per day. Saying so is better than letting them
           write out a second one and collect a 409. */
        <p className="setting-hint" style={{ margin: 0 }}>
          A request for this day is already open, so a second one cannot be filed until it is
          decided. If it is wrong, ask your manager to reject it — you can file again immediately
          afterwards.
        </p>
      ) : (
        open && (
          <RegularizationForm
            date={date}
            day={day}
            timeZone={timeZone}
            onBehalf={onBehalf}
            onFiled={() => {
              setOpen(false)
              onFiled()
            }}
          />
        )
      )}
    </div>
  )
}

/* ------------------------------------------------------- my own history -- */

/**
 * Everything this employee has ever asked for, and what came of it.
 *
 * The rows are the caller's own — `GET /regularization` takes its subject from
 * the authenticated caller, and passing somebody else's `user_id` is a 403
 * rather than an empty list, so there is nothing to widen here by accident.
 */
export function MyRegularizations({
  rows,
  loading,
  refetching,
  error,
  timeZone,
  onOpenDay,
}: {
  rows: RegRequest[] | undefined
  loading: boolean
  refetching: boolean
  error: string | null
  timeZone: string | undefined
  onOpenDay?: (date: string) => void
}) {
  const [view, setView] = useState<'all' | RegStatus>('all')
  const superseded = useMemo(() => supersededIds(rows ?? []), [rows])
  const shown = useMemo(
    () => (rows ?? []).filter((row) => (view === 'all' ? true : row.status === view)),
    [rows, view],
  )
  const pendingCount = (rows ?? []).filter((row) => row.status === 'pending').length

  return (
    <section className="card" style={{ marginTop: 14 }}>
      <div className="card-head">
        <h2 className="card-title">My correction requests</h2>
        <div className="ts-toggle ts-toggle-xs">
          {(['all', 'pending', 'approved', 'rejected'] as const).map((key) => (
            <button
              key={key}
              className={`ts-toggle-btn${view === key ? ' ts-toggle-on' : ''}`}
              onClick={() => setView(key)}
            >
              {key === 'all' ? 'All' : REG_STATUS[key].short}
              {key === 'pending' && pendingCount > 0 ? ` ${pendingCount}` : ''}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !rows && <Loading label="Reading your requests…" />}

      {rows && (
        <div className={refetching ? 'refetching' : undefined}>
          {rows.length === 0 ? (
            <EmptyState
              title="You have not asked for a correction"
              body="Pick a day on the calendar above and use “Ask for a correction” when a punch is missing or wrong. A manager decides it, and only an approval changes the record."
            />
          ) : shown.length === 0 ? (
            <Empty>Nothing with that status.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Asked for</th>
                    <th>Reason</th>
                    <th>Status</th>
                    <th>What happened</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => {
                    const filer = filerLabel(row)
                    return (
                      <tr key={row.id}>
                        <td>
                          {onOpenDay ? (
                            <button className="link-btn" onClick={() => onOpenDay(row.date)}>
                              {longDate(row.date)}
                            </button>
                          ) : (
                            longDate(row.date)
                          )}
                          {filer && <div className="att-reg-meta">filed by {filer}</div>}
                        </td>
                        <td className="att-reg-asked">{askedLabel(row, timeZone)}</td>
                        <td className="att-reg-reason">{row.reason}</td>
                        <td>
                          <RegStatusPill status={row.status} />
                        </td>
                        <td>
                          <Outcome
                            row={row}
                            timeZone={timeZone}
                            supersededBy={superseded.get(row.id)}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/* ---------------------------------------------------------- review queue -- */

/** `can_approve_regularization` restricts, it does not grant, so *absent* means
    not-restricted — read it with `!== false` and never with a bare truthiness
    check, or a browser holding a page from before the flag shipped hides a
    control the person is entitled to. The role gate is separate and the server
    applies both: `require_regularization_approver` is built on `TeamViewer`. */
export function canApproveRegularization(user: { can_approve_regularization?: boolean } | null) {
  return user?.can_approve_regularization !== false
}

/**
 * One pending request, with the single decision it admits.
 *
 * There is no `/approve` and no `/reject`: `POST /{id}/review` takes
 * `status: 'approved' | 'rejected'`, which is why this is one control with two
 * outcomes rather than two buttons that post to two places.
 */
function ReviewCard({
  row,
  timeZone,
  viewerId,
  viewerIsOwner,
  onDecided,
  onStale,
}: {
  row: RegRequest
  timeZone: string | undefined
  viewerId: string | undefined
  viewerIsOwner: boolean
  onDecided: (row: RegRequest, status: RegStatus) => void
  /** Somebody else decided it while this card was on screen. */
  onStale: () => void
}) {
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<RegStatus | null>(null)
  const [failure, setFailure] = useState<TypedFailure | null>(null)

  /* The service refuses self-review unless the viewer is the owner, who is
     exempt because in a small company there may be nobody above them. Rendering
     a button that always 403s is worse than rendering none. */
  const isSelf = viewerId !== undefined && row.user_id === viewerId
  const blockedSelf = isSelf && !viewerIsOwner
  const filer = filerLabel(row)
  const span = minutesBetween(row.requested_check_in, row.requested_check_out)

  async function decide(status: RegStatus) {
    // Mirrors the service's `note_required`. A rejection with no reason
    // guarantees the identical request comes back tomorrow.
    if (status === 'rejected' && !note.trim()) return
    setBusy(status)
    setFailure(null)
    try {
      const updated = await api.post<RegRequest>(`/regularization/${row.id}/review`, {
        status,
        review_note: note.trim() || null,
      })
      onDecided(updated, status)
    } catch (err) {
      const failed = typedError(err)
      setFailure(failed)
      /* A co-approver got there first, or the row is gone. Leaving the card on
         screen would invite a second attempt at a decision that can only be
         refused again — deciding twice is refused precisely so the first
         decision is not overwritten by nothing. */
      if (failed.reason === 'already_decided' || failed.reason === 'not_found') onStale()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="att-reg-card">
      <div className="att-reg-card-head">
        <Identity
          name={row.user_name ?? 'Unnamed'}
          small
          meta={
            <>
              {longDate(row.date)}
              {filer ? ` · filed by ${filer}` : ''}
            </>
          }
        />
        <div className="att-reg-meta">waiting {since(row.created_at)}</div>
      </div>

      <div className="att-reg-ask">
        <span className="att-reg-asked">{askedLabel(row, timeZone)}</span>
        {span !== null && span > 0 && <span className="att-reg-meta"> · {hm(span)} worked</span>}
      </div>
      <div className="att-reg-note">“{row.reason}”</div>

      {failure && (
        <div style={{ marginTop: 8 }}>
          <ErrorNote>{failure.message}</ErrorNote>
        </div>
      )}

      {blockedSelf ? (
        <p className="setting-hint" style={{ marginTop: 10, marginBottom: 0 }}>
          This is your own request. Deciding it would mean rewriting your own attendance record,
          so somebody above you has to.
        </p>
      ) : (
        <>
          {rejecting && (
            <label className="setting" style={{ marginTop: 10 }}>
              Why are you rejecting it?
              <textarea
                className="set-textarea"
                rows={2}
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="The gate log has you arriving at 09:40, not 08:30."
                disabled={busy !== null}
              />
              <span className="setting-hint">
                Required. Without it the same request arrives again tomorrow, and the audit row
                cannot answer the only question ever asked of it.
              </span>
            </label>
          )}

          {!rejecting && (
            <label className="setting" style={{ marginTop: 10 }}>
              Note (optional)
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
                placeholder="Confirmed against the visitor book."
                disabled={busy !== null}
              />
              <span className="setting-hint">
                Shown to the employee, and it becomes the day’s note on the record.
              </span>
            </label>
          )}

          <div className="att-form-actions">
            <button
              className="btn btn-primary"
              disabled={busy !== null || rejecting}
              onClick={() => void decide('approved')}
            >
              {busy === 'approved' ? 'Approving…' : 'Approve and write it in'}
            </button>
            {rejecting ? (
              <>
                <button
                  className="btn"
                  disabled={busy !== null || !note.trim()}
                  onClick={() => void decide('rejected')}
                >
                  {busy === 'rejected' ? 'Rejecting…' : 'Confirm rejection'}
                </button>
                <button className="btn btn-ghost" disabled={busy !== null} onClick={() => setRejecting(false)}>
                  Back
                </button>
              </>
            ) : (
              <button className="btn" disabled={busy !== null} onClick={() => setRejecting(true)}>
                Reject…
              </button>
            )}
          </div>

          <p className="setting-hint" style={{ marginTop: 8, marginBottom: 0 }}>
            Approving overwrites only the halves that were asked for, re-classifies the day, and
            clears the location evidence on the punches it moves — a coordinate captured at the
            original time is not proof of a time you decided. Rejecting changes nothing at all.
          </p>
        </>
      )}
    </div>
  )
}

const QUEUE_VIEWS: Array<{ id: RegStatus; label: string }> = [
  { id: 'pending', label: 'Awaiting you' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
]

/**
 * The manager's regularization queue.
 *
 * Scope is the server's — `/regularization/review` filters by
 * `hierarchy.visible_user_ids`, the one answer in this codebase to "whose data
 * may this manager see". Nothing here re-derives it, and nothing here widens it.
 */
export function RegularizationQueue({ timeZone }: { timeZone: string | undefined }) {
  const { user } = useAuth()
  const [view, setView] = useState<RegStatus>('pending')
  const [reloadKey, setReloadKey] = useState(0)
  const [notice, setNotice] = useState<ReactNode>(null)

  const queue = useQuery<RegRequest[]>(`att-reg-review:${view}:${reloadKey}`, () =>
    api.get<RegRequest[]>(`/regularization/review?status=${view}`),
  )

  const rows = queue.data ?? []
  const oldest = rows.reduce<string | null>(
    (acc, row) => (acc === null || row.created_at < acc ? row.created_at : acc),
    null,
  )
  const people = new Set(rows.map((row) => row.user_id)).size

  function afterDecision(row: RegRequest, status: RegStatus) {
    setNotice(
      status === 'approved' ? (
        <>
          <b>
            Approved — {row.user_name ?? 'that employee'}’s record for {longDate(row.date)} now
            reads {askedLabel(row, timeZone)}.
          </b>
          <div className="att-verdict-detail">
            The day was re-classified at approval time under the same precedence every other row
            was judged by, and the punches you moved no longer carry location evidence. The
            nightly job will leave this day alone from now on — which is what the FIXED badge on
            the calendar is telling the employee.
          </div>
        </>
      ) : (
        <>
          <b>Rejected. The attendance record was not touched.</b>
          <div className="att-verdict-detail">
            {row.user_name ?? 'The employee'} has been told, with your reason, and may file a
            corrected request for {longDate(row.date)} straight away.
          </div>
        </>
      ),
    )
    setReloadKey((k) => k + 1)
  }

  return (
    <div>
      <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
        <StatTile
          label={view === 'pending' ? 'Awaiting you' : `${REG_STATUS[view].short} by your line`}
          value={String(rows.length)}
          accent={view === 'pending' && rows.length ? 'var(--status-warn)' : undefined}
          meta={`${people} ${people === 1 ? 'person' : 'people'}`}
        />
        <StatTile
          label={view === 'pending' ? 'Oldest waiting' : 'Oldest filed'}
          value={oldest ? since(oldest) : '—'}
          meta={
            view === 'pending'
              ? 'Corrections have a deadline nobody in the queue can see — the payroll run.'
              : 'Decided requests stay on record permanently.'
          }
        />
      </div>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Attendance corrections</h2>
          <div className="ts-toggle ts-toggle-xs">
            {QUEUE_VIEWS.map((v) => (
              <button
                key={v.id}
                className={`ts-toggle-btn${view === v.id ? ' ts-toggle-on' : ''}`}
                onClick={() => {
                  setView(v.id)
                  setNotice(null)
                }}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>

        {notice && (
          <div className="att-verdict att-verdict-ok" style={{ marginBottom: 12 }}>
            {notice}
          </div>
        )}

        {queue.error && <ErrorNote>{queue.error}</ErrorNote>}
        {queue.loading && !queue.data && <Loading label="Reading the queue…" />}

        {queue.data && (
          <div className={queue.refetching ? 'refetching' : undefined}>
            {rows.length === 0 ? (
              <EmptyState
                title={
                  view === 'pending'
                    ? 'Nothing waiting on you'
                    : view === 'approved'
                      ? 'You have approved no corrections'
                      : 'You have rejected nothing'
                }
                body={
                  view === 'pending'
                    ? 'Corrections filed by anyone in your reporting line land here. Employees file them from a day on their own calendar; you can file one on somebody’s behalf from the Muster tab — open their last thirty days and pick the date.'
                    : 'Decided requests stay on record permanently — this table is the durable history, not the pointer on the attendance row.'
                }
              />
            ) : view === 'pending' ? (
              <div className="att-reg-cards">
                {rows.map((row) => (
                  <ReviewCard
                    key={row.id}
                    row={row}
                    timeZone={timeZone}
                    viewerId={user?.id}
                    viewerIsOwner={user?.role === 'owner'}
                    onDecided={afterDecision}
                    onStale={() => setReloadKey((k) => k + 1)}
                  />
                ))}
              </div>
            ) : (
              <DecidedTable rows={rows} timeZone={timeZone} />
            )}
          </div>
        )}
      </section>
    </div>
  )
}

function DecidedTable({ rows, timeZone }: { rows: RegRequest[]; timeZone: string | undefined }) {
  const superseded = useMemo(() => supersededIds(rows), [rows])
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Employee</th>
            <th>Day</th>
            <th>Asked for</th>
            <th>Reason</th>
            <th>What happened</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const filer = filerLabel(row)
            return (
              <tr key={row.id}>
                <td>
                  <Identity name={row.user_name ?? 'Unnamed'} small />
                </td>
                <td>
                  {longDate(row.date)}
                  {filer && <div className="att-reg-meta">filed by {filer}</div>}
                </td>
                <td className="att-reg-asked">{askedLabel(row, timeZone)}</td>
                <td className="att-reg-reason">{row.reason}</td>
                <td>
                  <Outcome row={row} timeZone={timeZone} supersededBy={superseded.get(row.id)} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
