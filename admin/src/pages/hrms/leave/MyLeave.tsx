import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { useAuth } from '../../../lib/auth'
import { dateTime, shortDate, todayISO } from '../../../lib/format'
import { Empty, EmptyState, ErrorNote, Loading, Meter, StatTile } from '../../../components/ui'
import '../../../styles/leave.css'

/* ===========================================================================
   Shapes, units and the two helpers the other two Leave pages also need.

   These live here rather than in a fourth file because `src/lib/types.ts` is
   lead-owned and this engineer owns exactly three pages plus a stylesheet.
   `Timesheets.tsx` already exports `hm` and `ApprovalPill` to its neighbours,
   so a page exporting its vocabulary is the house pattern rather than a
   workaround. If a fourth surface needs them — §9.3's employee home or §9.4's
   merged inbox will — they belong in `lib/`, and the lead should move them.
   =========================================================================== */

/** 1/1000 of a day. Mirrors `app.models.leave.MILLI_DAYS_PER_DAY`.
 *
 *  D-012: a leave balance is a policy unit, not a duration, and it is an
 *  integer on the wire for the same reason money is integer paise. Nothing on
 *  these pages does float arithmetic on one — the `*_days` floats the API sends
 *  alongside are for display convenience only and are never computed from. */
export const MILLI_DAYS_PER_DAY = 1000

export interface LeaveType {
  id: string
  name: string
  code: string | null
  description: string | null
  is_paid: boolean
  accrual_type: 'monthly' | 'yearly' | 'none'
  accrual_rate_milli_days: number
  max_balance_milli_days: number
  carry_forward_limit_milli_days: number
  carry_forward_all: boolean
  min_notice_days: number
  requires_approval: boolean
  allow_half_day: boolean
  is_comp_off: boolean
  /** Whether an unused balance is paid out in the exit settlement. False by
   *  default — over-paying a settlement is the expensive way to be wrong. */
  is_encashable: boolean
  is_active: boolean
  accrual_rate_days: number
}

export interface LeaveBalance {
  id: string
  user_id: string
  leave_type_id: string
  year: number
  /* The four stored components. The API sends all four deliberately so a manual
     correction is visible instead of folded silently into a total — which is
     why this page shows them rather than only `available_milli_days`. */
  opening_milli_days: number
  accrued_milli_days: number
  used_milli_days: number
  adjusted_milli_days: number
  balance_milli_days: number
  entitled_milli_days: number
  pending_milli_days: number
  available_milli_days: number
  balance_days: number
  available_days: number
  user_name: string | null
  leave_type_name: string | null
  leave_type_code: string | null
  is_paid: boolean
  adjusted_reason: string | null
  adjusted_by_user_id: string | null
  adjusted_at: string | null
}

export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export interface LeaveApplication {
  id: string
  user_id: string
  leave_type_id: string
  start_date: string
  end_date: string
  is_half_day: boolean
  half_day_session: 'first_half' | 'second_half' | null
  /** Frozen at apply time (D-013). What approval debits and cancellation
   *  credits back — never recomputed, by the server or by us. */
  duration_milli_days: number
  duration_days: number
  reason: string | null
  status: LeaveStatus
  applied_at: string
  reviewed_at: string | null
  reviewed_by_user_id: string | null
  review_note: string | null
  cancelled_at: string | null
  debited_at: string | null
  user_name: string | null
  leave_type_name: string | null
  reviewed_by_name: string | null
  balance_after_milli_days: number | null
}

export interface Holiday {
  id: string
  holiday_date: string
  name: string
  description: string | null
  is_optional: boolean
  is_active: boolean
  opted_in: boolean
  opt_in_count: number | null
}

export interface LeaveSettingsOut {
  org_id: string
  leave_year_start_month: number
  optional_holiday_quota: number
  is_configured: boolean
  optional_holidays_are_unlimited: boolean
}

export interface CompOffCredit {
  id: string
  user_id: string
  earned_date: string
  reason: string | null
  credit_milli_days: number
  credit_days: number
  expires_at: string
  expired_at: string | null
  used_in_application_id: string | null
  granted_by_user_id: string | null
  user_name: string | null
  granted_by_name: string | null
  is_expired: boolean
  is_used: boolean
}

/* ------------------------------------------------------------ formatting -- */

/**
 * Milli-days → "1½", "2.25", "0". Integer arithmetic only.
 *
 * Never `milli / 1000` into a rendered string: the whole point of the integer
 * unit is that the number people are paid against never meets binary rounding.
 * A half day is written ½ because that is the unit people actually take.
 */
export function days(milli: number): string {
  const whole = Math.trunc(Math.abs(milli) / MILLI_DAYS_PER_DAY)
  const rest = Math.abs(milli) % MILLI_DAYS_PER_DAY
  const sign = milli < 0 ? '−' : ''
  if (rest === 0) return `${sign}${whole}`
  if (rest === MILLI_DAYS_PER_DAY / 2) return `${sign}${whole === 0 ? '' : whole}½`
  const frac = String(rest).padStart(3, '0').replace(/0+$/, '')
  return `${sign}${whole}.${frac}`
}

/** "1½ days" / "1 day" — for prose, where the unit has to be spoken. */
export function dayLabel(milli: number): string {
  return `${days(milli)} ${Math.abs(milli) === MILLI_DAYS_PER_DAY ? 'day' : 'days'}`
}

/** "+2", "−1½" — for the signed `adjusted` component, where the sign is the fact. */
export function signedDays(milli: number): string {
  if (milli === 0) return '0'
  return milli > 0 ? `+${days(milli)}` : days(milli)
}

/**
 * The sentence out of a typed error body.
 *
 * The API refuses with `{reason, message}` so the console can branch on the
 * code rather than on prose. `lib/api.ts` (lead-owned) has no case for an
 * object detail, so it falls through to `JSON.stringify` and the sentence
 * arrives wrapped in braces. Unwrap it here rather than showing an employee
 * `{"reason":"insufficient_balance",…}`.
 */
export function errorText(err: unknown, fallback = 'That did not work'): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (!raw.trim()) return fallback
  const parsed = parseTyped(raw)
  return parsed?.message ?? raw
}

/** The machine-readable half of the same body, or null. */
export function errorReason(err: unknown): string | null {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return parseTyped(raw)?.reason ?? null
}

function parseTyped(raw: string): { reason?: string; message?: string } | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const body = JSON.parse(trimmed) as Record<string, unknown>
    return {
      reason: typeof body.reason === 'string' ? body.reason : undefined,
      message: typeof body.message === 'string' ? body.message : undefined,
    }
  } catch {
    // api.ts truncates to 300 characters, so a long detail is not valid JSON
    // any more. The raw string is still better than a status code.
    return null
  }
}

const STATUS_TEXT: Record<LeaveStatus, string> = {
  pending: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
}

export function StatusPill({ status }: { status: LeaveStatus }) {
  return <span className={`lv-pill lv-${status}`}>{STATUS_TEXT[status] ?? status}</span>
}

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** "12 – 16 Mar" or "Mar 12" for a single day. Year shown only when it is not this one. */
export function rangeLabel(start: string, end: string): string {
  const thisYear = todayISO().slice(0, 4)
  const suffix = start.slice(0, 4) === thisYear ? '' : ` ${start.slice(0, 4)}`
  if (start === end) return `${shortDate(start)}${suffix}`
  return `${shortDate(start)} – ${shortDate(end)}${suffix}`
}

/** Inclusive calendar-day span. A plain fact about the dates — NOT a duration. */
export function calendarSpan(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`)
  const b = Date.parse(`${end}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0
  return Math.round((b - a) / 86_400_000) + 1
}

export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd
}

/** Is this holiday a day off for the person who asked? Optional holidays are
 *  not holidays for anyone who did not opt into them — the server answers
 *  `opted_in` for the caller, so this is a read, not a rule. */
export function isOffFor(holiday: Holiday): boolean {
  return holiday.is_active && (!holiday.is_optional || holiday.opted_in)
}

export function addDaysISO(iso: string, delta: number): string {
  const ms = Date.parse(`${iso}T00:00:00Z`)
  if (Number.isNaN(ms)) return iso
  return new Date(ms + delta * 86_400_000).toISOString().slice(0, 10)
}

/* ===========================================================================
   The page
   =========================================================================== */

export default function MyLeave() {
  const { user } = useAuth()
  const [applying, setApplying] = useState(false)
  const [notice, setNotice] = useState<ReactNode>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const types = useQuery<LeaveType[]>('leave-types', () => api.get<LeaveType[]>('/leave/types'))
  const balances = useQuery<LeaveBalance[]>(`leave-balances:${reloadKey}`, () =>
    api.get<LeaveBalance[]>('/leave/balances'),
  )
  const applications = useQuery<LeaveApplication[]>(`leave-apps:${reloadKey}`, () =>
    api.get<LeaveApplication[]>('/leave/applications'),
  )
  const holidays = useQuery<Holiday[]>('leave-holidays-all', () =>
    api.get<Holiday[]>('/leave/holidays'),
  )

  const compOffType = types.data?.find((t) => t.is_comp_off) ?? null
  const compOffs = useQuery<CompOffCredit[]>(
    `leave-compoffs:${reloadKey}`,
    () => api.get<CompOffCredit[]>('/leave/comp-offs'),
    { enabled: Boolean(compOffType) },
  )

  function afterWrite(message: ReactNode) {
    setNotice(message)
    setApplying(false)
    setReloadKey((n) => n + 1)
  }

  const error = types.error ?? balances.error ?? applications.error
  if (error) return <ErrorNote>{errorText(error)}</ErrorNote>
  if (types.loading || balances.loading || !types.data || !balances.data) return <Loading />

  const activeTypes = types.data.filter((t) => t.is_active)
  const pending = (applications.data ?? []).filter((a) => a.status === 'pending')
  const approvedAhead = (applications.data ?? []).filter(
    (a) => a.status === 'approved' && a.end_date >= todayISO(),
  )
  /* Paid types only. Adding unpaid leave into a headline "you have N days" is
     how somebody plans a holiday against leave that costs them a day's pay. */
  const availablePaid = balances.data
    .filter((b) => b.is_paid)
    .reduce((sum, b) => sum + b.available_milli_days, 0)
  const policyYear = balances.data.reduce((max, b) => Math.max(max, b.year), 0)

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">My Leave</h1>
          <p className="page-sub">
            Your balances, and what each one is made of.
          </p>
        </div>
      </div>

      {notice && (
        <div className="notice notice-ok" style={{ marginBottom: 14 }}>
          {notice}
        </div>
      )}

      {activeTypes.length === 0 ? (
        <section className="card">
          <EmptyState
            title="No leave types yet"
            body={
              <>
                Nobody can apply for leave until an administrator defines at least one type —
                Casual, Sick and Earned Leave are the usual first three. Each one carries its
                own accrual rate, carry-forward rule and notice period.
                <br />
                They are created in <b>Leave Settings</b>.
              </>
            }
          />
        </section>
      ) : (
        <>
          <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
            <StatTile
              label="Available to apply for"
              value={days(availablePaid)}
              meta="across paid types, after pending"
            />
            <StatTile
              label="Awaiting a decision"
              value={String(pending.length)}
              meta={
                pending.length
                  ? `holding ${dayLabel(
                      pending.reduce((s, a) => s + a.duration_milli_days, 0),
                    )}`
                  : 'nothing pending'
              }
            />
            <StatTile
              label="Approved and still to come"
              value={String(approvedAhead.length)}
              meta={
                approvedAhead.length
                  ? `next: ${rangeLabel(approvedAhead[approvedAhead.length - 1].start_date, approvedAhead[approvedAhead.length - 1].end_date)}`
                  : 'nothing booked'
              }
            />
          </div>

          <section className="card" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <h2 className="card-title">Balances</h2>
              {/* The comp-off balance carries the sentinel year 0 — it is not
                  year-scoped — so the policy year is the largest one present,
                  never simply the first row's. */}
              <span className="card-note">
                {policyYear > 0 ? `Policy year ${policyYear}` : ''}
              </span>
            </div>
            <div className={`lv-balances${balances.refetching ? ' refetching' : ''}`}>
              {balances.data.map((balance) => (
                <BalanceCard
                  key={balance.leave_type_id}
                  balance={balance}
                  leaveType={types.data?.find((t) => t.id === balance.leave_type_id) ?? null}
                />
              ))}
            </div>
          </section>

          <section className="card" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <h2 className="card-title">Apply for leave</h2>
              <button className="btn btn-sm" onClick={() => { setApplying((v) => !v); setNotice(null) }}>
                {applying ? 'Cancel' : 'New application'}
              </button>
            </div>
            {applying ? (
              <ApplyForm
                types={activeTypes}
                balances={balances.data}
                holidays={holidays.data ?? []}
                onDone={afterWrite}
              />
            ) : (
              <p className="lv-note" style={{ margin: 0 }}>
                Weekly-offs and public holidays inside a range are skipped, so a Friday-to-Monday
                request over an ordinary weekend costs two days, not four. The exact figure is
                worked out and frozen by the server the moment you apply — this form never sends
                one, and it never changes afterwards even if the holiday calendar does.
              </p>
            )}
          </section>
        </>
      )}

      {compOffType && (
        <CompOffCard credits={compOffs.data ?? []} typeName={compOffType.name} />
      )}

      <History
        applications={applications.data ?? []}
        loading={applications.loading}
        selfId={user?.id ?? ''}
        onDone={afterWrite}
      />
    </div>
  )
}

/* ------------------------------------------------------------- balances --- */

function BalanceCard({ balance, leaveType }: { balance: LeaveBalance; leaveType: LeaveType | null }) {
  const [open, setOpen] = useState(false)
  const corrected = balance.adjusted_milli_days !== 0
  const compOff = leaveType?.is_comp_off ?? false

  return (
    <div className="card lv-bal">
      <div className="lv-bal-head">
        <div>
          <div className="lv-bal-name">{balance.leave_type_name ?? 'Leave'}</div>
          <div className="lv-sub">
            {balance.leave_type_code ? `${balance.leave_type_code} · ` : ''}
            {balance.is_paid ? 'Paid' : 'Unpaid'}
            {compOff ? ' · comp-off' : ''}
          </div>
        </div>
        {corrected && <span className="badge badge-warn">Corrected</span>}
      </div>

      <div className="lv-bal-figure">
        <span className={`lv-bal-value${balance.available_milli_days <= 0 ? ' lv-bal-none' : ''}`}>
          {days(balance.available_milli_days)}
        </span>
        <span className="lv-bal-unit">available to apply for</span>
      </div>

      {/* Against everything granted this year, not against the balance — a bar
          that shrinks its own maximum as you spend it measures nothing. */}
      <Meter value={Math.max(0, balance.available_milli_days)} max={Math.max(1, balance.entitled_milli_days)} />

      <div className="lv-bal-foot">
        <span>
          balance {days(balance.balance_milli_days)}
          {balance.pending_milli_days > 0 && ` · ${days(balance.pending_milli_days)} pending`}
        </span>
        <button className="link-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Hide the working' : 'Why this number?'}
        </button>
      </div>

      {open && (
        <div className="lv-breakdown">
          <dl className="lv-ledger">
            <dt>Opening</dt>
            <dd>{days(balance.opening_milli_days)}</dd>
            <dt>Accrued{compOff ? ' from credits' : ' this year'}</dt>
            <dd className={balance.accrued_milli_days > 0 ? 'lv-pos' : undefined}>
              {signedDays(balance.accrued_milli_days)}
            </dd>
            <dt>Used</dt>
            <dd className={balance.used_milli_days > 0 ? 'lv-neg' : undefined}>
              {balance.used_milli_days === 0 ? '0' : `−${days(balance.used_milli_days)}`}
            </dd>
            <dt>Adjusted by hand</dt>
            <dd className={corrected ? (balance.adjusted_milli_days > 0 ? 'lv-pos' : 'lv-neg') : undefined}>
              {signedDays(balance.adjusted_milli_days)}
            </dd>

            <dt className="lv-rule lv-total">Balance</dt>
            <dd className="lv-rule lv-total">{days(balance.balance_milli_days)}</dd>
            <dt>Held by pending applications</dt>
            <dd className={balance.pending_milli_days > 0 ? 'lv-neg' : undefined}>
              {balance.pending_milli_days === 0 ? '0' : `−${days(balance.pending_milli_days)}`}
            </dd>
            <dt className="lv-rule lv-total">Available</dt>
            <dd className="lv-rule lv-total">{days(balance.available_milli_days)}</dd>
          </dl>

          {corrected && (
            <div className="lv-attrib">
              <b>Corrected by hand.</b>{' '}
              {balance.adjusted_reason ? `“${balance.adjusted_reason}”` : 'No reason recorded.'}
              {balance.adjusted_at && <> · {dateTime(balance.adjusted_at)}</>}
            </div>
          )}

          {compOff && (
            <p className="lv-sub" style={{ marginTop: 10 }}>
              This balance is a projection of your comp-off credits, and only the credits move
              it. It is not scoped to a policy year — each credit expires on its own date.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/* ----------------------------------------------------------------- apply -- */

interface ApplyState {
  leave_type_id: string
  start_date: string
  end_date: string
  is_half_day: boolean
  half_day_session: 'first_half' | 'second_half'
  reason: string
}

function ApplyForm({
  types,
  balances,
  holidays,
  onDone,
}: {
  types: LeaveType[]
  balances: LeaveBalance[]
  holidays: Holiday[]
  onDone: (message: ReactNode) => void
}) {
  const today = todayISO()
  const [form, setForm] = useState<ApplyState>({
    leave_type_id: types[0]?.id ?? '',
    start_date: today,
    end_date: today,
    is_half_day: false,
    half_day_session: 'first_half',
    reason: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState<string | null>(null)

  const selected = types.find((t) => t.id === form.leave_type_id) ?? null
  const balance = balances.find((b) => b.leave_type_id === form.leave_type_id) ?? null

  /* Holidays inside the range that are days off for *this* employee. The server
     answers `opted_in` per caller, so an optional holiday somebody did not
     choose correctly does not appear here — they are expected at work. */
  const skipped = useMemo(
    () =>
      holidays
        .filter((h) => isOffFor(h) && h.holiday_date >= form.start_date && h.holiday_date <= form.end_date)
        .sort((a, b) => a.holiday_date.localeCompare(b.holiday_date)),
    [holidays, form.start_date, form.end_date],
  )

  const span = calendarSpan(form.start_date, form.end_date)
  const earliest =
    selected && selected.min_notice_days > 0 ? addDaysISO(today, selected.min_notice_days) : null

  function patch(next: Partial<ApplyState>) {
    setForm((prev) => {
      const merged = { ...prev, ...next }
      // A half day covers exactly one date; the API refuses anything else, so
      // the form should not let you build it in the first place.
      if (merged.is_half_day) merged.end_date = merged.start_date
      if (merged.end_date < merged.start_date) merged.end_date = merged.start_date
      return merged
    })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!selected) return
    setBusy(true)
    setError(null)
    setReason(null)
    try {
      /* No duration field, on purpose. The number of days a range costs depends
         on the holiday calendar and this employee's working days, so the server
         computes it and freezes it (D-013). A client-supplied duration would be
         forgeable balance. */
      const created = await api.post<LeaveApplication>('/leave/applications', {
        leave_type_id: form.leave_type_id,
        start_date: form.start_date,
        end_date: form.end_date,
        is_half_day: form.is_half_day,
        half_day_session: form.is_half_day ? form.half_day_session : null,
        reason: form.reason.trim() || null,
      })
      onDone(
        <>
          <b>
            Applied for {dayLabel(created.duration_milli_days)} of{' '}
            {created.leave_type_name ?? selected.name}
          </b>{' '}
          ({rangeLabel(created.start_date, created.end_date)}).{' '}
          {/* Compared in milli-days rather than dividing the frozen figure —
              the integer unit is the point. */}
          {span * MILLI_DAYS_PER_DAY > created.duration_milli_days && !created.is_half_day && (
            <>
              The range spans {span} calendar days; weekly-offs and holidays inside it were
              skipped.{' '}
            </>
          )}
          That figure is now frozen — later changes to the holiday calendar will not move it.{' '}
          {created.status === 'approved'
            ? 'This type does not require approval, so it is already approved and your balance has been debited.'
            : 'It is with your approver, and is holding that much of your balance until they decide.'}
        </>,
      )
    } catch (err) {
      setError(errorText(err, 'Could not file that application'))
      setReason(errorReason(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="lv-form" onSubmit={submit}>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>
            {error}
            {reason === 'insufficient_balance' && (
              <div className="lv-sub" style={{ marginTop: 6 }}>
                Anything already awaiting a decision is still holding balance. Open the balance
                card above to see the working.
              </div>
            )}
            {reason === 'overlapping_leave' && (
              <div className="lv-sub" style={{ marginTop: 6 }}>
                Cancel the existing application in your history below first, then re-apply.
              </div>
            )}
            {reason === 'no_working_days' && (
              <div className="lv-sub" style={{ marginTop: 6 }}>
                Every date in that range is a weekly-off or a holiday you are already off for,
                so there is nothing to spend balance on.
              </div>
            )}
          </ErrorNote>
        </div>
      )}

      <div className="settings-grid">
        <label className="setting">
          Leave type
          <select
            value={form.leave_type_id}
            onChange={(e) => patch({ leave_type_id: e.target.value, is_half_day: false })}
            required
          >
            {types.map((t) => {
              const b = balances.find((x) => x.leave_type_id === t.id)
              return (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {b ? ` — ${days(b.available_milli_days)} available` : ''}
                </option>
              )
            })}
          </select>
          {selected && !selected.requires_approval && (
            <span className="setting-hint">
              Approved on submission — this type is a declaration, not a request. It debits
              straight away.
            </span>
          )}
        </label>

        <label className="setting">
          {form.is_half_day ? 'Date' : 'First day'}
          <input
            type="date"
            value={form.start_date}
            onChange={(e) => patch({ start_date: e.target.value })}
            required
          />
          {earliest && (
            <span className="setting-hint">
              {selected?.name} needs {selected?.min_notice_days} days’ notice — the earliest
              you can start is {shortDate(earliest)}.
            </span>
          )}
        </label>

        {!form.is_half_day && (
          <label className="setting">
            Last day
            <input
              type="date"
              value={form.end_date}
              min={form.start_date}
              onChange={(e) => patch({ end_date: e.target.value })}
              required
            />
          </label>
        )}

        {selected?.allow_half_day && (
          <div className="setting">
            Half day
            <label className="check-field">
              <input
                type="checkbox"
                checked={form.is_half_day}
                onChange={(e) => patch({ is_half_day: e.target.checked })}
              />
              <span>Take half of one day</span>
            </label>
            {form.is_half_day && (
              <>
                <div className="lv-session" style={{ marginTop: 6 }}>
                  {(['first_half', 'second_half'] as const).map((session) => (
                    <label className="check-field" key={session}>
                      <input
                        type="radio"
                        name="half_day_session"
                        checked={form.half_day_session === session}
                        onChange={() => patch({ half_day_session: session })}
                      />
                      <span>{session === 'first_half' ? 'First half' : 'Second half'}</span>
                    </label>
                  ))}
                </div>
                <span className="setting-hint">
                  Which half matters: attendance records the other one as a day you were
                  expected in.
                </span>
              </>
            )}
          </div>
        )}
      </div>

      <label className="setting" style={{ marginTop: 14 }}>
        Reason <span className="setting-hint">Optional, but your approver reads it.</span>
        <textarea
          className="set-textarea"
          value={form.reason}
          maxLength={2000}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
          placeholder="Family wedding, medical appointment…"
        />
      </label>

      <div className="lv-cost">
        <div className="lv-cost-head">What this will cost</div>
        {form.is_half_day ? (
          <>
            Half a day, taken as the{' '}
            <b>{form.half_day_session === 'first_half' ? 'first half' : 'second half'}</b> of{' '}
            {shortDate(form.start_date)} — unless that date is a weekly-off or a holiday, in
            which case there is nothing to apply for and the server will say so.
          </>
        ) : (
          <>
            The range covers <b>{span}</b> calendar {span === 1 ? 'day' : 'days'}. Your weekly-offs
            and any holiday you are off for are skipped, so the number of days it actually spends
            is lower.{' '}
            {skipped.length > 0 ? (
              <>
                {skipped.length} {skipped.length === 1 ? 'holiday falls' : 'holidays fall'} inside it:
                <ul className="lv-skip-list">
                  {skipped.map((h) => (
                    <li key={h.id}>
                      <span className="lv-skip-date">{shortDate(h.holiday_date)}</span>
                      <span>
                        {h.name}
                        {h.is_optional && ' (optional — you opted in)'}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              'No public holiday falls inside it.'
            )}
          </>
        )}
        <div className="lv-sub" style={{ marginTop: 8 }}>
          The exact figure is computed by the server and frozen onto the application when you
          submit — this form deliberately does not send one, and cannot guess your weekly-offs.
          You will see the frozen number in the confirmation and in your history below.
        </div>
        {balance && (
          <div className="lv-sub" style={{ marginTop: 4 }}>
            You have {days(balance.available_milli_days)} available in {selected?.name}.
          </div>
        )}
      </div>

      <div style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy || !selected}>
          {busy ? 'Filing…' : 'Apply'}
        </button>
      </div>
    </form>
  )
}

/* --------------------------------------------------------------- history -- */

const HISTORY_FILTERS: Array<{ id: string; label: string }> = [
  { id: '', label: 'All' },
  { id: 'pending', label: 'Awaiting' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'cancelled', label: 'Cancelled' },
]

function History({
  applications,
  loading,
  selfId,
  onDone,
}: {
  applications: LeaveApplication[]
  loading: boolean
  selfId: string
  onDone: (message: ReactNode) => void
}) {
  const [filter, setFilter] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)

  const rows = applications.filter((a) => !filter || a.status === filter)

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">My applications</h2>
        <div className="ts-toggle" role="group" aria-label="Status">
          {HISTORY_FILTERS.map((f) => (
            <button
              key={f.id || 'all'}
              className={`ts-toggle-btn ${filter === f.id ? 'ts-toggle-on' : ''}`}
              onClick={() => setFilter(f.id)}
              aria-pressed={filter === f.id}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <Loading />
      ) : applications.length === 0 ? (
        <Empty>
          You have not applied for any leave yet. Applications you file stay here for good —
          approved, rejected and withdrawn alike.
        </Empty>
      ) : rows.length === 0 ? (
        <Empty>Nothing with that status.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Dates</th>
                <th>Type</th>
                <th className="num">Days</th>
                <th>Status</th>
                <th>Decision</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const open = openId === row.id
                const cancellable =
                  (row.status === 'pending' || row.status === 'approved') && row.user_id === selfId
                return [
                  <tr key={row.id}>
                    <td>
                      <b>{rangeLabel(row.start_date, row.end_date)}</b>
                      <div className="lv-sub">
                        {row.is_half_day
                          ? `Half day, ${row.half_day_session === 'first_half' ? 'first half' : 'second half'}`
                          : `applied ${dateTime(row.applied_at)}`}
                      </div>
                    </td>
                    <td>{row.leave_type_name ?? '—'}</td>
                    <td className="num lv-mono">{days(row.duration_milli_days)}</td>
                    <td><StatusPill status={row.status} /></td>
                    <td>
                      <DecisionCell application={row} />
                    </td>
                    <td className="num">
                      {cancellable && (
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => setOpenId(open ? null : row.id)}
                        >
                          {open ? 'Keep it' : 'Withdraw'}
                        </button>
                      )}
                    </td>
                  </tr>,
                  open ? (
                    <tr key={`${row.id}-cancel`}>
                      <td colSpan={6}>
                        <CancelPanel
                          application={row}
                          onCancelled={onDone}
                          onClose={() => setOpenId(null)}
                        />
                      </td>
                    </tr>
                  ) : null,
                ]
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function DecisionCell({ application }: { application: LeaveApplication }) {
  const note = application.review_note?.trim()
  if (application.status === 'pending') {
    return (
      <span className="lv-sub">
        Holding {dayLabel(application.duration_milli_days)} until it is decided.
      </span>
    )
  }
  if (application.status === 'rejected') {
    return (
      <span className="lv-sub">
        {application.reviewed_by_name ? `${application.reviewed_by_name}: ` : ''}
        {note || 'No reason recorded'}
        <br />
        Nothing was debited — a rejection never spends balance.
      </span>
    )
  }
  if (application.status === 'cancelled') {
    /* `debited_at` is cleared by the credit-back, so it cannot answer "was this
       ever debited" after the fact. `reviewed_at` can: an application withdrawn
       while still pending was never decided, and one withdrawn after approval
       was — and approval is the debit. */
    const wasApproved = application.reviewed_at !== null
    return (
      <span className="lv-sub">
        {wasApproved
          ? `Withdrawn after approval — ${dayLabel(application.duration_milli_days)} was credited back.`
          : 'Withdrawn before it was decided — it had not been debited.'}
        {note && (
          <>
            <br />
            {note}
          </>
        )}
      </span>
    )
  }
  return (
    <span className="lv-sub">
      {application.reviewed_by_name ? `by ${application.reviewed_by_name}` : 'Auto-approved'}
      {application.reviewed_at && <> · {dateTime(application.reviewed_at)}</>}
      <br />
      {application.debited_at
        ? `${dayLabel(application.duration_milli_days)} debited.`
        : 'Approved, but the debit has not landed — tell an administrator.'}
    </span>
  )
}

function CancelPanel({
  application,
  onCancelled,
  onClose,
}: {
  application: LeaveApplication
  onCancelled: (message: ReactNode) => void
  onClose: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const debited = application.debited_at !== null
  const alreadyStarted = application.start_date <= todayISO()

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const updated = await api.post<LeaveApplication>(
        `/leave/applications/${application.id}/cancel`,
        { reason: reason.trim() || null },
      )
      onClose()
      onCancelled(
        debited ? (
          <>
            <b>Withdrawn.</b> {dayLabel(updated.duration_milli_days)} has been credited back to{' '}
            {updated.leave_type_name ?? 'that leave type'} — the same frozen figure that was
            debited when it was approved, not a recalculation.
          </>
        ) : (
          <>
            <b>Withdrawn.</b> It had not been approved, so nothing had been debited; the{' '}
            {dayLabel(updated.duration_milli_days)} it was holding is available again.
          </>
        ),
      )
    } catch (err) {
      setError(errorText(err, 'Could not withdraw that application'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lv-row-form">
      <div className="notice notice-warn" style={{ marginBottom: 10 }}>
        <b>Withdrawing is not the same as being rejected.</b>{' '}
        {debited ? (
          <>
            This leave was approved and <b>{dayLabel(application.duration_milli_days)} was
            debited</b> from your balance. Withdrawing credits exactly that figure back — the one
            frozen when you applied, so a change to the holiday calendar since then cannot leave
            you short.
          </>
        ) : (
          <>
            This is still awaiting a decision, so nothing has been debited yet. It is holding{' '}
            {dayLabel(application.duration_milli_days)} of your balance, which is released as soon
            as you withdraw it.
          </>
        )}
        {alreadyStarted && (
          <>
            <br />
            This leave has already started. If it has finished, only an administrator can undo it
            — cancelling leave somebody genuinely took would credit back days they were absent for.
          </>
        )}
      </div>
      {error && <div style={{ marginBottom: 10 }}><ErrorNote>{error}</ErrorNote></div>}
      <label className="setting">
        Why are you withdrawing it? <span className="setting-hint">Optional. Appended to the record, not replacing your approver’s note.</span>
        <input value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="lv-actions" style={{ marginTop: 10 }}>
        <button className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
          {busy ? 'Withdrawing…' : 'Withdraw this application'}
        </button>
        <button className="btn btn-sm" onClick={onClose} disabled={busy}>
          Keep it
        </button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- comp-off -- */

function CompOffCard({ credits, typeName }: { credits: CompOffCredit[]; typeName: string }) {
  const live = credits.filter((c) => !c.is_expired && !c.is_used)
  return (
    <section className="card" style={{ marginBottom: 14 }}>
      <div className="card-head">
        <h2 className="card-title">{typeName} credits</h2>
        <span className="card-note">
          {live.length ? `${dayLabel(live.reduce((s, c) => s + c.credit_milli_days, 0))} still spendable` : 'none spendable'}
        </span>
      </div>
      {credits.length === 0 ? (
        <Empty>
          No comp-off credits. These are granted by a manager for work on a day you were off —
          they are never self-service, and each one expires on its own date.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Earned</th><th className="num">Worth</th><th>Expires</th><th>Status</th><th>Why</th>
              </tr>
            </thead>
            <tbody>
              {credits.map((credit) => (
                <tr key={credit.id} className={credit.is_expired || credit.is_used ? 'lv-past' : undefined}>
                  <td>{shortDate(credit.earned_date)}</td>
                  <td className="num lv-mono">{days(credit.credit_milli_days)}</td>
                  <td>{shortDate(credit.expires_at)}</td>
                  <td>
                    {credit.is_used ? (
                      <span className="badge">Spent</span>
                    ) : credit.is_expired ? (
                      <span className="badge badge-warn">Expired</span>
                    ) : (
                      <span className="badge badge-ok">Spendable</span>
                    )}
                  </td>
                  <td className="lv-sub">
                    {credit.reason ?? '—'}
                    {credit.granted_by_name && <> · granted by {credit.granted_by_name}</>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
