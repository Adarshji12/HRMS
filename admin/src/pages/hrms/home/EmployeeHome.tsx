import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import '../../../styles/hrmshome.css'
/* The three sibling stylesheets whose pills this page reuses. Importing them is
   the point rather than an accident: `AttendanceStatusPill`, `ApprovalPill` and
   `TicketStatusPill` are the *same* components those pages render, so a status
   here and a status there cannot drift into looking like two different states. */
import '../../../styles/attendance.css'
import '../../../styles/timesheets.css'
import '../../../styles/helpdesk.css'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import {
  canAdminister,
  canApproveSomething,
  canViewTeam,
  isOwner,
  useAuth,
} from '../../../lib/auth'
import type { NavAccess } from '../../../lib/nav'
import { clockTime, duration, shortDate } from '../../../lib/format'
import Tabs, { TabPanel } from '../../../components/Tabs'
import Welcome from './Welcome'
import { Empty, EmptyState, ErrorNote, Loading, Meter } from '../../../components/ui'
import WorkModePicker, { type WorkMode } from '../../../components/WorkModePicker'
import { IconCheck, IconClock, IconInfo } from '../../../components/Icons'
import { ApprovalPill } from '../../Timesheets'
import {
  StatusPill as AttendanceStatusPill,
  orgToday,
  typedError,
  type AttendanceDay,
  type Enforcement,
} from '../attendance/MyAttendance'
import {
  days as leaveDays,
  errorText,
  isOffFor,
  type Holiday,
  type LeaveBalance,
} from '../leave/MyLeave'
import { TicketStatusPill, type Ticket } from '../helpdesk/Helpdesk'
import { progressOf, type OnbInstanceDetail } from '../onboarding/Onboarding'

/**
 * The employee home — §9.3's "day one" screen.
 *
 * One landing page over all **nine** modules, module 1 (time tracking and
 * timesheets) included. That inclusion is the part worth stating plainly:
 * module 1 is a peer here, not the foundation the other eight sit on. An
 * employee's Monday morning question is "am I in, are my hours in, and how much
 * leave have I got", and answering two thirds of it would be worse than
 * answering none, because they would stop looking.
 *
 * Two rules hold the whole file together.
 *
 * **Every card owns its own request and its own failure.** There are six
 * calls behind this page, they run in parallel, and none of them can take the
 * page down. If `/leave/balances` 404s because nobody has configured leave
 * types yet, the leave card says so and the punch button beside it still works.
 * A dashboard that blanks entirely because one of six calls failed is worse
 * than no dashboard — it removes a working punch button on the strength of an
 * unrelated outage.
 *
 * **Empty is the ordinary state, not a fault.** On someone's first morning
 * there is no leave history, no ticket, no onboarding checklist and no tracked
 * time. Every card is written for that morning first and the busy case second.
 *
 * Nothing here re-derives a permission. `hidden_pages` closes a card before it
 * is ever requested, so a person switched out of Leave sees no leave card
 * rather than a 403 dressed up as an error — but the server still enforces it,
 * and if a call does come back refused we render the sentence it sent.
 */

/* ---------------------------------------------------------------- types ---
   Page-local, mirroring the server schemas, exactly as every other HRMS page
   does. `lib/types.ts` is lead-owned. Shapes that another page already spelled
   out are imported from that page rather than copied — `MyLeave.tsx` says in
   its own header that this screen is who it was exporting them for. */

/** `timesheets.py` — one row of `Timesheet.as_dict()["days"]`. */
interface TimesheetDay {
  date: string
  weekday: string
  is_working_day: boolean
  worked_minutes: number
  expected_minutes: number
}

/** The approval envelope. `status` alone is present on a period never touched. */
interface TimesheetApproval {
  status: 'draft' | 'submitted' | 'approved' | 'rejected'
  submitted_at?: string | null
  note?: string | null
  approved_worked_minutes?: number
}

/** `GET /timesheets` for the caller. Only the fields this page reads. */
interface MyWeek {
  period_start: string
  period_end: string
  days: TimesheetDay[]
  totals: {
    worked_minutes: number
    tracked_minutes: number
    expected_minutes: number
    overtime_minutes: number
    days_worked: number
    working_days: number
  }
  approval: TimesheetApproval
  can_edit: boolean
}

/* The onboarding shapes are `OnbInstanceDetail` and `OnbTask` from
   `onboarding/Onboarding.tsx`, which owns that module's UI — along with
   `progressOf`, which exists because `OnboardingInstanceOut.progress_pct` is a
   plain Python property that Pydantic does not serialise. Recomputing progress
   here would be a second definition of "how far along is this hire", and the
   two would disagree the first time somebody decided a skipped task should
   count. `GET /onboarding/my` answers `null`, not a 404, when the caller is not
   being onboarded — the ordinary state for almost everyone in the company. */

/** `PunchResultOut`. The verdict is about *this punch*, not about the day. */
interface PunchResult {
  record: AttendanceDay
  is_geo_verified: boolean
  distance_m: number | null
  nearest_office_name: string | null
  enforcement: Enforcement
}

/* -------------------------------------------------------------- helpers --- */

/**
 * Minutes on the wire → "7h 30m".
 *
 * Delegates to `lib/format.duration`, which is the console's single duration
 * renderer, rather than adding a fourth private copy of the same nine lines.
 * The multiply is exact integer work — every duration in this codebase is
 * integer minutes (D-012) and this never turns one into a float.
 */
function mins(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  return m === 0 ? '—' : duration(m * 60)
}

/**
 * Ask the browser where we are, and give up quickly.
 *
 * Resolves rather than rejects: denial is the **normal** path and the punch
 * must succeed either way — `PunchIn.lat`/`lng` are optional server-side for
 * exactly this reason. The extra timer is belt and braces; some browsers call
 * neither callback while an unanswered permission prompt sits on screen.
 *
 * This duplicates `requestFix` in `MyAttendance.tsx`, which is private to that
 * file. Two punch buttons in the product should not have two definitions of
 * "how hard do we try to find you" — see the report: this belongs in `lib/`,
 * and the lead should lift it there and have both pages import it.
 */
function requestFix(): Promise<{ lat: number; lng: number; accuracy_m: number | null } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null)
      return
    }
    let settled = false
    const finish = (fix: { lat: number; lng: number; accuracy_m: number | null } | null) => {
      if (settled) return
      settled = true
      resolve(fix)
    }
    const guard = window.setTimeout(() => finish(null), 9500)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        window.clearTimeout(guard)
        const accuracy = position.coords.accuracy
        finish({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          // The server widens the fence by this, so it must stay inside the
          // schema's 0…100000 bound rather than arriving as Infinity.
          accuracy_m: Number.isFinite(accuracy)
            ? Math.min(100000, Math.max(0, Math.round(accuracy)))
            : null,
        })
      },
      () => {
        window.clearTimeout(guard)
        finish(null)
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
    )
  })
}

function addDaysISO(iso: string, delta: number): string {
  const ms = Date.parse(`${iso}T00:00:00Z`)
  if (Number.isNaN(ms)) return iso
  return new Date(ms + delta * 86_400_000).toISOString().slice(0, 10)
}

/** Whole days from today to `iso`, on the calendar rather than the clock. */
function daysUntil(iso: string, today: string): number {
  const a = Date.parse(`${today}T00:00:00Z`)
  const b = Date.parse(`${iso}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

/** The structural half of `useQuery`'s return. Its own interface is not
 *  exported, and a card only ever reads these four fields. */
interface Slice<T> {
  data: T | undefined
  error: string | null
  loading: boolean
  refetching: boolean
}

/**
 * One card's four states — loading, refused, empty, answered.
 *
 * The refetch case matters as much as the failure case: `useQuery` keeps
 * `refetching` separate from `loading` precisely so a poll re-renders the
 * previous answer at reduced opacity instead of collapsing the card to a
 * spinner and shoving every card below it up the page.
 */
function Slot<T>({
  q,
  loadingLabel,
  children,
}: {
  q: Slice<T>
  loadingLabel: string
  children: (data: T) => ReactNode
}) {
  if (q.loading) return <Loading label={loadingLabel} />
  if (q.error) return <ErrorNote>{errorText(q.error, 'This could not be loaded')}</ErrorNote>
  if (q.data === undefined) return <Empty>Nothing to show yet.</Empty>
  return <div className={q.refetching ? 'refetching' : undefined}>{children(q.data)}</div>
}

function Card({
  title,
  note,
  foot,
  children,
}: {
  title: string
  note?: ReactNode
  foot?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="card hm-card">
      <div className="card-head">
        <h2 className="card-title">{title}</h2>
        {note !== undefined && note !== null && <span className="card-note">{note}</span>}
      </div>
      <div className="hm-card-body">{children}</div>
      {foot && <div className="hm-card-foot">{foot}</div>}
    </section>
  )
}

/* ============================================================== the page === */

const TAB_KEY = 'hrdesktimesol.home-tab'
type HomeTab = 'welcome' | 'dashboard'

/**
 * `/home`, in two panels.
 *
 * People arrive here for one of two reasons and the page used to serve only
 * the second. **Welcome** is for somebody who came to *do* one thing — punch,
 * apply, look up a payslip — and wants the door, not a report. **Dashboard** is
 * the six cards this page has always been, for somebody who came to find out
 * where they stand. Welcome leads, because the door is the more common errand
 * and it is the cheaper of the two to walk past.
 *
 * The dashboard is mounted lazily and then kept. Six requests fire the first
 * time it is opened and never again on a toggle — mounting it up front would
 * make everyone who only ever wants a shortcut pay for six calls, and
 * unmounting it on the way back to Welcome would re-fire them on every switch.
 * `hidden` rather than a conditional render is what makes "kept" true; React
 * would otherwise drop the state on the branch not taken.
 */
export default function EmployeeHome() {
  const { user } = useAuth()

  /* Rebuilt here rather than threaded through the router: the shell computes
     the same object for the rail, and a prop chain through <Routes> to reach
     one page would be a second definition of it in the router's signature.
     Same helpers, same source of truth — `lib/auth`. */
  const access = useMemo<NavAccess>(
    () => ({
      isAdmin: canAdminister(user),
      canViewTeam: canViewTeam(user),
      isOwner: isOwner(user),
      canApprove: canApproveSomething(user),
      hiddenPages: user?.hidden_pages ?? [],
    }),
    [user],
  )

  const [tab, setTab] = useState<HomeTab>(() =>
    localStorage.getItem(TAB_KEY) === 'dashboard' ? 'dashboard' : 'welcome',
  )
  const [visitedDashboard, setVisitedDashboard] = useState(tab === 'dashboard')

  function choose(next: HomeTab) {
    setTab(next)
    if (next === 'dashboard') setVisitedDashboard(true)
    try {
      localStorage.setItem(TAB_KEY, next)
    } catch {
      /* A private window. The choice holds for this session and no further. */
    }
  }

  return (
    <div className="home-switch">
      <div className="home-switch-bar">
        <Tabs
          label="Home view"
          value={tab}
          onChange={choose}
          items={[
            { id: 'welcome', label: 'Welcome' },
            { id: 'dashboard', label: 'Dashboard' },
          ]}
        />
      </div>

      <TabPanel id="welcome">
        <div hidden={tab !== 'welcome'}>
          <Welcome access={access} />
        </div>
      </TabPanel>

      <TabPanel id="dashboard">
        {visitedDashboard && (
          <div hidden={tab !== 'dashboard'}>
            <HomeDashboard />
          </div>
        )}
      </TabPanel>
    </div>
  )
}

function HomeDashboard() {
  const { user, organization } = useAuth()
  const [punchKey, setPunchKey] = useState(0)

  /* Today in the organisation's calendar, not the browser's. The server's
     attendance day is `local_day(org)` (D-003), so a viewer in another timezone
     asking for "today" by browser clock would page the wrong day. */
  const tz = organization?.timezone
  const today = orgToday(tz)
  const yesterday = addDaysISO(today, -1)

  /* `hidden_pages` restricts, and the server enforces it — but a card whose
     only possible answer is a 403 is not a card, it is a broken one. Close it
     here so the page is shorter rather than louder. Attendance, helpdesk and
     onboarding have no PAGE_GUARDS entry on the server, so there is nothing to
     read for them and nothing to pretend to read. */
  const hidden = user?.hidden_pages ?? []
  const showLeave = !hidden.includes('leave')
  const showTimesheet = !hidden.includes('timesheets')

  /* Six calls, all in flight together, none of them able to take another one
     down. `useQuery` fires on mount, so declaring them here is what makes them
     parallel — there is no await chain anywhere on this page. */

  /* Two days, one request: today's row and yesterday's. Yesterday is not
     decoration — a night shift punched in at 22:00 has no check-out on its own
     date, and the only honest thing to offer that person at 06:00 is "punch
     out of yesterday", not a disabled button. */
  const attendance = useQuery<AttendanceDay[]>(
    `home-att:${today}:${punchKey}`,
    () => api.get<AttendanceDay[]>(`/attendance/me?start=${yesterday}&end=${today}`),
    { pollMs: 120_000 },
  )
  const week = useQuery<MyWeek>(
    `home-week:${today}`,
    () => api.get<MyWeek>(`/timesheets?period=weekly&day=${today}`),
    { enabled: showTimesheet },
  )
  const balances = useQuery<LeaveBalance[]>(
    'home-balances',
    () => api.get<LeaveBalance[]>('/leave/balances'),
    { enabled: showLeave },
  )
  /* No `year` filter: the next holiday is routinely in the next policy year,
     and asking for this year would answer "none" every December. The whole
     active calendar is a few dozen rows. */
  const holidays = useQuery<Holiday[]>('home-holidays', () => api.get<Holiday[]>('/leave/holidays'), {
    enabled: showLeave,
  })
  const tickets = useQuery<Ticket[]>('home-tickets', () =>
    api.get<Ticket[]>('/helpdesk/tickets?open_only=true'),
  )
  const onboarding = useQuery<OnbInstanceDetail | null>('home-onboarding', () =>
    api.get<OnbInstanceDetail | null>('/onboarding/my'),
  )

  const todayRow = attendance.data?.find((d) => d.date === today) ?? null
  const yesterdayRow = attendance.data?.find((d) => d.date === yesterday) ?? null

  return (
    <div>
      <div className="page-head">
        <div>
          {/* Not a second greeting. The welcome panel next door already said
              good morning and named the reader; repeating it one tab away
              would make the toggle look like it had done nothing. This head
              says what the panel holds. */}
          <h1 className="hm-greeting">Your day</h1>
          <p className="page-sub">
            {new Date(`${today}T12:00:00`).toLocaleDateString(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
            {tz ? ` · times in ${tz}` : ''}
          </p>
        </div>
      </div>

      <PunchCard
        today={todayRow}
        yesterday={yesterdayRow}
        loading={attendance.loading}
        refetching={attendance.refetching}
        error={attendance.error}
        timezone={tz}
        onPunched={() => setPunchKey((n) => n + 1)}
      />

      <div className="hm-grid" style={{ marginTop: 14 }}>
        {showTimesheet && <WeekCard q={week} />}
        {showLeave && <LeaveCard q={balances} />}
        <OnboardingCard q={onboarding} />
        <TicketsCard q={tickets} />
        {showLeave && <HolidayCard q={holidays} today={today} />}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------- punch card ---- */

function PunchCard({
  today,
  yesterday,
  loading,
  refetching,
  error,
  timezone,
  onPunched,
}: {
  today: AttendanceDay | null
  yesterday: AttendanceDay | null
  loading: boolean
  refetching: boolean
  error: string | null
  timezone: string | undefined
  onPunched: () => void
}) {
  const [phase, setPhase] = useState<{ kind: 'in' | 'out'; step: 'locating' | 'sending' } | null>(
    null,
  )
  const [result, setResult] = useState<{ kind: 'in' | 'out'; punch: PunchResult } | null>(null)
  /* Same default and the same reason as the attendance page: Office is the
     common case and the strict one, so a mode that relaxes the geofence has to
     be chosen rather than defaulted into. */
  const [workMode, setWorkMode] = useState<WorkMode>('office')
  const [note, setNote] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  const busy = phase !== null
  /* A check-in with no check-out on *yesterday's* date is a night shift still
     running. Punching out then closes that day, not this one. */
  const openNightShift =
    yesterday && yesterday.check_in_at && !yesterday.check_out_at ? yesterday : null
  const canPunchIn = !today?.check_in_at && !openNightShift
  const canPunchOut = Boolean((today?.check_in_at && !today.check_out_at) || openNightShift)

  async function punch(kind: 'in' | 'out') {
    setResult(null)
    setFailure(null)
    setPhase({ kind, step: 'locating' })
    const fix = await requestFix()
    setPhase({ kind, step: 'sending' })
    try {
      const punched = await api.post<PunchResult>(`/attendance/punch/${kind}`, {
        lat: fix?.lat ?? null,
        lng: fix?.lng ?? null,
        accuracy_m: fix?.accuracy_m ?? null,
        source: 'web',
        note: kind === 'in' ? note.trim() || null : null,
        // Only on the way in — the day's mode was declared this morning and the
        // server reads it off the row when closing.
        work_mode: kind === 'in' ? workMode : null,
      })
      setResult({ kind, punch: punched })
      setNote('')
      setWorkMode('office')
      onPunched()
    } catch (err) {
      setFailure(typedError(err).message)
    } finally {
      setPhase(null)
    }
  }

  const label = (kind: 'in' | 'out', idle: string) => {
    if (phase?.kind !== kind) return idle
    return phase.step === 'locating' ? 'Finding your location…' : 'Recording…'
  }

  return (
    <section className="card">
      {loading ? (
        <Loading label="Reading today…" />
      ) : error ? (
        /* The punch card failing costs the punch card. Everything below it on
           this page is still rendered from its own request. */
        <ErrorNote>{errorText(error, 'Today could not be read')}</ErrorNote>
      ) : (
        <div className={`hm-punch${refetching ? ' refetching' : ''}`}>
          <div>
            <div className={`hm-clock${today?.check_in_at || openNightShift ? '' : ' hm-clock-idle'}`}>
              {today?.check_in_at
                ? clockTime(today.check_in_at, timezone)
                : openNightShift
                  ? clockTime(openNightShift.check_in_at, timezone)
                  : 'Not in yet'}
            </div>
            <div className="hm-clock-sub">
              {openNightShift ? (
                <>
                  You checked in on {shortDate(openNightShift.date)} and never checked out.
                  Punching out closes <b>that</b> day, not today.
                </>
              ) : today?.check_out_at ? (
                <>
                  Checked out at {clockTime(today.check_out_at, timezone)} ·{' '}
                  {mins(today.worked_minutes)} worked. Today is closed.
                </>
              ) : today?.check_in_at ? (
                <>
                  Checked in
                  {today.shift_name
                    ? ` · ${today.shift_name} ${today.shift_start_time}–${today.shift_end_time}`
                    : ''}
                  . Punch out when you finish.
                </>
              ) : (
                <>
                  Punch in when you start. Your location is attached if the browser offers it, and
                  the punch is recorded either way.
                </>
              )}
            </div>

            {/* The same question the attendance page asks, from the same
                component — two punch buttons in the product must not have two
                definitions of what the modes are. Only while a check-in is
                still possible. */}
            {canPunchIn && (
              <>
                <WorkModePicker value={workMode} onChange={setWorkMode} disabled={busy} />
                <label className="setting" style={{ marginBottom: 12 }}>
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
              </>
            )}

            <div className="hm-punch-actions">
              <button
                className="btn btn-primary"
                disabled={busy || !canPunchIn}
                onClick={() => void punch('in')}
              >
                {label('in', 'Punch in')}
              </button>
              <button className="btn" disabled={busy || !canPunchOut} onClick={() => void punch('out')}>
                {label('out', openNightShift ? 'Punch out of yesterday' : 'Punch out')}
              </button>
              <Link className="btn btn-sm" to="/attendance">
                Calendar &amp; corrections
              </Link>
            </div>

            {result && (
              <div className="notice notice-ok" style={{ marginTop: 12 }}>
                Punched {result.kind === 'in' ? 'in' : 'out'} at{' '}
                <b>
                  {clockTime(
                    result.kind === 'in'
                      ? result.punch.record.check_in_at
                      : result.punch.record.check_out_at,
                    timezone,
                  )}
                </b>
                {/* `enforcement` comes off the punch itself, not off a
                    settings read: it is the policy that was applied to *this*
                    punch, which is the only version of it worth reporting, and
                    it saves the page a whole request. */}
                {result.punch.is_geo_verified && result.punch.nearest_office_name ? (
                  <> at {result.punch.nearest_office_name}.</>
                ) : result.punch.enforcement === 'off' ? (
                  <>.</>
                ) : (
                  /* An unverified punch is a perfectly good punch. Say what was
                     recorded, not what went wrong — there is nothing here for
                     the employee to fix. */
                  <>. We could not confirm you were at an office; the punch stands.</>
                )}
              </div>
            )}
            {failure && <ErrorNote>{failure}</ErrorNote>}
          </div>

          <div className="hm-facts">
            <div>
              <div className="hm-fact-label">Status today</div>
              <div className="hm-fact-value">
                {today ? <AttendanceStatusPill status={today.status} /> : 'No record yet'}
              </div>
              <div className="hm-fact-meta">
                {today ? 'Finalised after the day ends.' : 'A row appears at your first punch.'}
              </div>
            </div>
            <div>
              <div className="hm-fact-label">Shift</div>
              <div className="hm-fact-value">{today?.shift_name ?? 'Unassigned'}</div>
              <div className="hm-fact-meta">
                {today?.shift_start_time
                  ? `${today.shift_start_time} – ${today.shift_end_time}`
                  : 'Nothing on the rota today, so nothing counts as late.'}
              </div>
            </div>
            <div>
              <div className="hm-fact-label">Worked today</div>
              <div className="hm-fact-value">{today ? mins(today.worked_minutes) : '—'}</div>
              <div className="hm-fact-meta">
                {today?.is_late
                  ? `${today.late_minutes} minutes after your shift start.`
                  : today?.check_out_at
                    ? 'Both punches recorded.'
                    : 'Counted when you punch out.'}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

/* ----------------------------------------------------------- week card ---- */

/**
 * Module 1, on the same page as the other eight.
 *
 * §9.3 names this explicitly and it is the easiest card to leave out, because
 * time tracking already has two pages of its own. It stays because the
 * submission deadline is the one timesheet fact that has a date attached to it,
 * and a person who forgets to submit does not forget on the Timesheets page —
 * they forget everywhere else.
 */
function WeekCard({ q }: { q: Slice<MyWeek> }) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  return (
    <Card
      title="This week"
      note={q.data ? `${shortDate(q.data.period_start)} – ${shortDate(q.data.period_end)}` : undefined}
      foot={<Link to="/timesheets">Open the timesheet →</Link>}
    >
      <Slot q={q} loadingLabel="Reading your week…">
        {(sheet) => {
          const t = sheet.totals
          const status = submitted ? 'submitted' : sheet.approval.status
          const locked = status === 'submitted' || status === 'approved'
          const peak = Math.max(...sheet.days.map((d) => d.worked_minutes), 1)

          async function submit() {
            setBusy(true)
            setFailure(null)
            try {
              await api.post(`/timesheets/submit?period=weekly&day=${sheet.period_start}`)
              /* Local, not a refetch: the period is unchanged, and re-reading
                 seven days of activity to learn one word is a slow way to be
                 told something the response already confirmed. */
              setSubmitted(true)
              setNotice('Sent for approval.')
            } catch (err) {
              setFailure(errorText(err, 'That could not be submitted'))
            } finally {
              setBusy(false)
            }
          }

          return (
            <>
              <div className="hm-week-figure">
                <span className="hm-week-value">{mins(t.worked_minutes)}</span>
                <span className="hm-week-of">
                  {t.expected_minutes > 0
                    ? `of ${mins(t.expected_minutes)} expected`
                    : 'no schedule set, so nothing is expected'}
                </span>
              </div>

              {t.expected_minutes > 0 && (
                <div className="hm-week-meter">
                  <Meter value={t.worked_minutes} max={t.expected_minutes} />
                </div>
              )}

              {/* Seven cells, one per day. Answers "when did I last track
                  anything" without opening the timesheet. */}
              <div className="hm-spark" aria-hidden="true">
                {sheet.days.map((d) => (
                  <div key={d.date} className="hm-spark-day" title={`${d.date}: ${mins(d.worked_minutes)}`}>
                    <div
                      className={`hm-spark-bar${
                        d.worked_minutes === 0
                          ? ' hm-spark-bar-empty'
                          : d.is_working_day
                            ? ''
                            : ' hm-spark-bar-off'
                      }`}
                      style={{ height: `${Math.max(6, (d.worked_minutes / peak) * 100)}%` }}
                    />
                  </div>
                ))}
              </div>
              <div className="hm-spark-labels" aria-hidden="true">
                {sheet.days.map((d) => (
                  <span key={d.date}>{d.weekday.slice(0, 1)}</span>
                ))}
              </div>

              <div className="hm-week-status">
                <ApprovalPill status={status} />
                {!locked && sheet.can_edit && (
                  <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void submit()}>
                    {busy ? 'Submitting…' : 'Submit for approval'}
                  </button>
                )}
              </div>

              {status === 'rejected' && sheet.approval.note && (
                <p className="hm-row-meta" style={{ marginTop: 8 }}>
                  <b>Changes requested:</b> {sheet.approval.note}
                </p>
              )}
              {status === 'approved' && (
                <p className="hm-row-meta" style={{ marginTop: 8 }}>
                  Frozen at {mins(sheet.approval.approved_worked_minutes ?? t.worked_minutes)} — later
                  corrections to activity will not change it.
                </p>
              )}
              {status === 'draft' && t.worked_minutes === 0 && (
                <p className="hm-row-meta" style={{ marginTop: 8 }}>
                  Nothing tracked this week yet. Hours arrive from the desktop agent as you work.
                </p>
              )}

              {notice && (
                <div className="notice notice-ok" style={{ marginTop: 10 }}>
                  {notice}
                </div>
              )}
              {failure && <ErrorNote>{failure}</ErrorNote>}
            </>
          )
        }}
      </Slot>
    </Card>
  )
}

/* ---------------------------------------------------------- leave card ---- */

function LeaveCard({ q }: { q: Slice<LeaveBalance[]> }) {
  return (
    <Card title="Leave" foot={<Link to="/leave">Balances, history &amp; apply →</Link>}>
      <Slot q={q} loadingLabel="Reading your balances…">
        {(rows) => {
          /* Types with nothing in them at all are noise on a summary — a new
             tenant has five leave types and zero of everything. Show what the
             person actually has, and account for the rest in one line rather
             than five empty ones. */
          const withBalance = rows.filter((r) => r.available_milli_days > 0)
          const shown = withBalance.length > 0 ? withBalance : rows
          const emptyTypes = rows.length - withBalance.length

          if (rows.length === 0) {
            return (
              <EmptyState
                title="No leave types yet"
                body="Once an administrator sets up the leave policy, your balances appear here."
              />
            )
          }

          return (
            <>
              <div className="hm-list">
                {shown.slice(0, 5).map((row) => (
                  <div className="hm-row" key={row.id}>
                    <div className="hm-row-main">
                      <div className="hm-row-title">{row.leave_type_name ?? 'Leave'}</div>
                      <div className="hm-row-meta">
                        {/* D-012: milli-days are integers on the wire and stay
                            integers here. `days()` formats by integer division
                            and remainder — nothing on this page divides by
                            1000 into a float. */}
                        {leaveDays(row.used_milli_days)} taken of{' '}
                        {leaveDays(row.entitled_milli_days)}
                        {row.pending_milli_days > 0 && (
                          <> · {leaveDays(row.pending_milli_days)} awaiting a decision</>
                        )}
                      </div>
                    </div>
                    <div
                      className={`hm-row-figure${
                        row.available_milli_days > 0 ? '' : ' hm-row-figure-none'
                      }`}
                    >
                      {leaveDays(row.available_milli_days)}
                      <span className="hm-row-figure-unit">left</span>
                    </div>
                  </div>
                ))}
              </div>
              {withBalance.length > 0 && emptyTypes > 0 && (
                <p className="hm-row-meta" style={{ marginTop: 8 }}>
                  {emptyTypes} other {emptyTypes === 1 ? 'type has' : 'types have'} nothing left.
                </p>
              )}
              {withBalance.length === 0 && (
                <p className="hm-row-meta" style={{ marginTop: 8 }}>
                  Nothing accrued yet. Balances build up over the leave year.
                </p>
              )}
            </>
          )
        }}
      </Slot>
    </Card>
  )
}

/* ----------------------------------------------------- onboarding card ---- */

/**
 * Only the tasks this person can actually close.
 *
 * A checklist carries HR's and IT's sign-offs alongside the employee's own, and
 * `services/onboarding.py` refuses a status change on a task whose `owner_role`
 * is somebody else's. Listing those here would put rows on a new hire's home
 * screen that 403 when touched, which is the opposite of what a day-one screen
 * is for. Progress across the whole checklist is still shown — knowing that
 * eleven of fourteen are done is reassuring; being blamed for the other three
 * is not.
 */
function OnboardingCard({ q }: { q: Slice<OnbInstanceDetail | null> }) {
  const { user } = useAuth()

  /* No checklist is the ordinary state for almost everyone in the company, and
     the endpoint says so with `null` rather than a 404. Render nothing at all
     — an empty "Onboarding" card on the home screen of someone who joined four
     years ago is clutter, not information. */
  if (!q.loading && !q.error && !q.data) return null

  return (
    <Card
      title="Your onboarding"
      note={q.data ? `${progressOf(q.data)}% done` : undefined}
    >
      <Slot q={q} loadingLabel="Reading your checklist…">
        {(instance) => {
          if (!instance) return null
          const mine = instance.groups
            .flatMap((g) => g.tasks)
            .filter(
              (t) =>
                t.status !== 'done' &&
                t.status !== 'skipped' &&
                (t.owner_role === 'employee' || t.assignee_user_id === user?.id),
            )
            .sort((a, b) => {
              if (a.is_overdue !== b.is_overdue) return a.is_overdue ? -1 : 1
              return (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999')
            })

          return (
            <>
              {instance.total_tasks > 0 && (
                <div style={{ marginBottom: 12 }}>
                  {/* Closed, not completed: a task HR marked "not applicable to
                      this hire" is a legitimate ending and must not hold the
                      bar at 90% forever. Same denominator progressOf uses. */}
                  <Meter value={instance.closed_tasks} max={instance.total_tasks} />
                  <div className="hm-row-meta" style={{ marginTop: 6 }}>
                    {instance.closed_tasks} of {instance.total_tasks} closed
                    {instance.completed_tasks < instance.closed_tasks &&
                      ` · ${instance.closed_tasks - instance.completed_tasks} not applicable`}
                  </div>
                </div>
              )}

              {mine.length === 0 ? (
                <EmptyState
                  icon={<IconCheck size={20} />}
                  title="Nothing waiting on you"
                  body={
                    instance.closed_tasks < instance.total_tasks
                      ? 'The rest of your checklist is with HR and IT. They will come to you if they need anything.'
                      : 'Your checklist is complete.'
                  }
                />
              ) : (
                <div className="hm-list">
                  {mine.slice(0, 5).map((task) => (
                    <div className="hm-row" key={task.id}>
                      <div className="hm-row-main">
                        <div className="hm-row-title">{task.title}</div>
                        <div className="hm-row-meta">
                          {task.is_overdue ? (
                            <b>Overdue</b>
                          ) : task.due_date ? (
                            `Due ${shortDate(task.due_date)}`
                          ) : (
                            'No due date'
                          )}
                          {task.requires_document && ' · needs a document'}
                        </div>
                      </div>
                    </div>
                  ))}
                  {mine.length > 5 && (
                    <p className="hm-row-meta" style={{ marginTop: 8 }}>
                      and {mine.length - 5} more.
                    </p>
                  )}
                </div>
              )}
            </>
          )
        }}
      </Slot>
    </Card>
  )
}

/* --------------------------------------------------------- tickets card --- */

function TicketsCard({ q }: { q: Slice<Ticket[]> }) {
  return (
    <Card
      title="Your open tickets"
      /* D-026, applied at the point it bites: this is a count of rows the
         server chose to send me, computed here from what is on screen. It is
         never read out of a count field, because the helpdesk schemas omit
         count keys for readers who may not see them and a confident zero
         teaches a reader as much as a confident eight. `TicketOut` carries no
         count field at all, which is how this route cannot grow one by
         accident — and this card must not reintroduce the idea. */
      note={q.data ? `${q.data.length} open` : undefined}
      foot={<Link to="/helpdesk">Helpdesk →</Link>}
    >
      <Slot q={q} loadingLabel="Reading your tickets…">
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState
              icon={<IconInfo size={20} />}
              title="Nothing open"
              body={
                <>
                  Raise a ticket when something needs HR or IT — a payslip query, a laptop that
                  will not boot, an access request.
                </>
              }
            />
          ) : (
            <div className="hm-list">
              {rows.slice(0, 5).map((ticket) => (
                <div className="hm-row" key={ticket.id}>
                  <div className="hm-row-main">
                    <div className="hm-row-title">{ticket.subject}</div>
                    <div className="hm-row-meta">
                      {ticket.category_name ?? 'Uncategorised'}
                      {ticket.assigned_to_name
                        ? ` · with ${ticket.assigned_to_name}`
                        : ' · not assigned yet'}
                    </div>
                  </div>
                  <TicketStatusPill value={ticket.status} />
                </div>
              ))}
              {rows.length > 5 && (
                <p className="hm-row-meta" style={{ marginTop: 8 }}>
                  and {rows.length - 5} more.
                </p>
              )}
            </div>
          )
        }
      </Slot>
    </Card>
  )
}

/* --------------------------------------------------------- holiday card --- */

function HolidayCard({ q, today }: { q: Slice<Holiday[]>; today: string }) {
  const next = useMemo(() => {
    const rows = q.data ?? []
    return (
      rows
        /* An optional holiday is not a holiday for anyone who did not opt into
           it. The server answers `opted_in` for the caller, so this is a read
           of their choice rather than a rule invented here. */
        .filter((h) => h.holiday_date >= today && isOffFor(h))
        .sort((a, b) => a.holiday_date.localeCompare(b.holiday_date))[0] ?? null
    )
  }, [q.data, today])

  return (
    <Card title="Next holiday" foot={<Link to="/leave">Full calendar →</Link>}>
      <Slot q={q} loadingLabel="Reading the calendar…">
        {() => {
          if (!next) {
            return (
              <EmptyState
                icon={<IconClock size={20} />}
                title="Nothing on the calendar"
                body="No holidays are published ahead of today. An administrator sets these up in Leave settings."
              />
            )
          }
          const away = daysUntil(next.holiday_date, today)
          return (
            <>
              <div className="hm-holiday-date">
                {new Date(`${next.holiday_date}T12:00:00`).toLocaleDateString(undefined, {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                })}
              </div>
              <div className="hm-holiday-name">{next.name}</div>
              <div className="hm-holiday-away">
                {away === 0
                  ? 'Today.'
                  : away === 1
                    ? 'Tomorrow.'
                    : `${away} days away.`}
                {next.is_optional && ' You opted into this one.'}
              </div>
            </>
          )
        }}
      </Slot>
    </Card>
  )
}
