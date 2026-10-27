import { useMemo, useState, type ReactNode } from 'react'
import '../../../styles/hrmshome.css'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { canViewTeam, useAuth } from '../../../lib/auth'
import { dateTime, duration, money, shortDate } from '../../../lib/format'
import { EmptyState, ErrorNote, Identity, Loading } from '../../../components/ui'
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconUsers,
  IconChevronDown,
  IconClose,
  IconFilter,
  IconReturn,
  IconSearch,
} from '../../../components/Icons'
import {
  askedLabel,
  canApproveRegularization,
  filerLabel,
  type RegRequest,
} from '../attendance/regularization'
import { dayLabel, days as leaveDays, errorText, rangeLabel, type LeaveApplication } from '../leave/MyLeave'
import { permits } from '../helpdesk/Helpdesk'

/**
 * The merged approvals inbox — §9.4.
 *
 * Six modules, one queue, sorted by age. What this file is **not** is a
 * workflow engine: each module already owns its own approve and reject
 * endpoints, already scopes its queue, and already writes its own audit row and
 * sends its own notification. This page is a read-side aggregation over their
 * review endpoints plus a per-row call back to whichever one produced that row.
 * Inventing a combined `POST /approvals/{id}/decide` would mean a sixth answer
 * to "whose data may this manager see" and a second place where a leave balance
 * gets debited, and neither is wanted.
 *
 * There *is* a server-side aggregation now — `GET /approvals`, over the same
 * five flows — and this page deliberately does not use it for the rows. It
 * shows what each decision turns on: the balance a leave approval spends, the
 * totals a timesheet approval freezes, how many lines a claim has. That
 * per-module context is exactly what a flat cross-module shape cannot carry,
 * and a queue that shows the request without the facts behind it is a queue
 * that approves by reflex. The flat endpoint serves the count, which cannot be
 * had any other way without fetching five queues on every page load.
 *
 * **Age is the organising idea, not the module.** A manager with eleven things
 * waiting does not think in modules; they think about the person who has been
 * waiting nine days. So the default view interleaves all three, oldest first,
 * and the module is a coloured rail and a three-letter label rather than a
 * section heading. The chips filter; they do not regroup.
 *
 * **Three permissions, not one.** D-002 split `can_approve_leave`,
 * `can_approve_regularization` and `can_approve_timesheets` deliberately — the
 * team lead who signs off "you were in the office at 09:15" is routinely not
 * the person who signs off "you may take nine days off". A lane the reader
 * cannot decide is not fetched, not counted and not shown; someone who can
 * decide none of the three gets an explanation instead of an empty queue,
 * because an empty queue reads as "nothing is waiting" and that would be a lie.
 */

/* ---------------------------------------------------------------- types ---
   Page-local, mirroring the server schemas. `lib/types.ts` is lead-owned, and
   shapes another page already spelled out are imported rather than copied. */

/* `RegRequest` and its two label helpers come from `attendance/regularization.tsx`,
   which owns that module's UI. A second copy of `askedLabel` here would let the
   inbox and the attendance queue describe the same request in two different
   ways — "in 08:30 · out 18:00 next day" is a surprisingly easy sentence to get
   subtly wrong twice. Same reason the leave vocabulary is imported from
   `MyLeave.tsx`: those files say in their own headers that this page is who
   they were exporting for. */

/** One row of `GET /performance/cycles/{id}/reviews?status_filter=self_submitted`.
 *  Only the fields this page reads — the full shape is in lib/types. */
interface PendingReview {
  id: string
  user_id: string
  user_name: string | null
  cycle_name: string | null
  self_submitted_at: string | null
  created_at: string
  self_comment: string | null
  goals: Array<{ id: string; title: string; self_rating: number | null }>
}

/** One row of `GET /expenses/review` — the claims awaiting this approver. */
interface PendingClaim {
  id: string
  user_id: string
  user_name: string | null
  title: string
  total_amount: number
  currency: string
  submitted_at: string | null
  created_at: string
  line_count: number
  note: string | null
}

/** One row of `GET /loans?status=requested`. */
interface PendingLoan {
  id: string
  user_id: string
  user_name: string | null
  principal: number
  instalment_count: number
  interest_rate_bps: number
  purpose: string | null
  requested_on: string
  currency: string
}

/** One row of `GET /timesheets/team`. */
interface TeamSheetRow {
  user_id: string
  full_name: string
  email: string
  totals: {
    worked_minutes: number
    expected_minutes: number
    overtime_minutes: number
    shortfall_minutes: number
    days_worked: number
  }
  approval: {
    status: 'draft' | 'submitted' | 'approved' | 'rejected'
    submitted_at?: string | null
    note?: string | null
  }
}

interface TeamSheet {
  period_type: string
  period_start: string
  period_end: string
  rows: TeamSheetRow[]
}

type Lane = 'regularization' | 'leave' | 'timesheet' | 'expense' | 'loan' | 'performance'

/** One row of the merged queue, whichever module produced it. */
interface InboxItem {
  key: string
  lane: Lane
  userId: string
  personName: string
  /** The instant this started waiting for a decision. The sort key. */
  waitingSince: string
  /** What is being asked for, in one line. */
  claim: ReactNode
  /** The facts a decision turns on. */
  facts: ReactNode
  /** The requester's own words, when they wrote any. */
  quote: string | null
  /** Call the module's own endpoint. `note` is required on a rejection. */
  decide: (approve: boolean, note: string) => Promise<void>
  /** What to say once it worked. */
  outcome: (approve: boolean) => string
}

/** A row the reader has just decided, and what the module said happened. */
interface Settled {
  approved: boolean
  message: string
}

const LANE_LABEL: Record<Lane, string> = {
  regularization: 'Attendance',
  leave: 'Leave',
  timesheet: 'Timesheet',
  expense: 'Expense',
  loan: 'Loan',
  performance: 'Review',
}

/* -------------------------------------------------------------- helpers --- */

/**
 * Parse a server timestamp into milliseconds, honouring the missing zone marker.
 *
 * SQLite drops `tzinfo`, so `applied_at` and `created_at` arrive as
 * "2026-08-18T06:23:53" with no `Z`. `Date.parse` reads a marker-less string as
 * *browser-local*, which shifts every age on this page by the viewer's offset —
 * enough, in India, to turn a request filed five hours ago into one filed in
 * the future, and this page sorts on exactly that number.
 *
 * `lib/format.ts` normalises this for `clockTime` and `dateTime` but **not**
 * for `relativeTime`, and its `asUTC` is private. That is why this exists and
 * why `relativeTime` is not used anywhere on this page — see the report.
 */
function instantMs(iso: string | null | undefined): number {
  if (!iso) return Number.NaN
  const normalised = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`
  return Date.parse(normalised)
}

/** "4 days" / "6 hours" / "20 minutes" — how long this has been waiting. */
function waited(iso: string, now: number): string {
  const ms = instantMs(iso)
  if (Number.isNaN(ms)) return 'unknown'
  const seconds = Math.max(0, (now - ms) / 1000)
  if (seconds < 3600) {
    const m = Math.max(1, Math.floor(seconds / 60))
    return `${m} ${m === 1 ? 'minute' : 'minutes'}`
  }
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600)
    return `${h} ${h === 1 ? 'hour' : 'hours'}`
  }
  const d = Math.floor(seconds / 86_400)
  return `${d} ${d === 1 ? 'day' : 'days'}`
}

/* Three bands, not a gradient. The product has no SLA, so finer shading would
   assert a policy that does not exist; "today", "this week" and "too long" is
   the most a queue can honestly say. */
function ageClass(iso: string, now: number): string {
  const hours = (now - instantMs(iso)) / 3_600_000
  if (!Number.isFinite(hours) || hours < 24) return 'ai-age-fresh'
  if (hours < 72) return 'ai-age-warm'
  return 'ai-age-stale'
}

/** Minutes on the wire → "7h 30m", through the console's one duration renderer. */
function mins(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  return m === 0 ? '—' : duration(m * 60)
}

/* Permission flags are read with `permits` (from `helpdesk/Helpdesk.tsx`) and
   `canApproveRegularization` (from `attendance/regularization.tsx`). Both test
   `!== false`, which is the only correct test: these columns **restrict, never
   grant**, so a browser holding a page from before a flag shipped reads
   `undefined` and must treat it as not-restricted rather than hiding a control
   the person is entitled to. The server enforces all three regardless; reading
   them here only stops us rendering a button that always 403s. */

/* ============================================================== the page === */

export default function ApprovalsInbox() {
  const { user, organization } = useAuth()
  /* The organisation's clock, not the browser's: a requested check-in is stored
     as an instant and only means anything read back in `org.timezone`, which is
     the zone the server validated it against. */
  const tz = organization?.timezone
  const [lane, setLane] = useState<Lane | 'all'>('all')
  const [reloadKey, setReloadKey] = useState(0)
  /* Rows the reader has just decided. Held here rather than refetched away, so
     the row can say what happened instead of vanishing mid-sentence — and so
     deciding row four never reflows rows one to three under the cursor. */
  const [settled, setSettled] = useState<Record<string, Settled>>({})
  /* Per-row failures live here rather than in the row, so a bulk approval can
     report which of the selected rows it could not record. */
  const [failures, setFailures] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [newestFirst, setNewestFirst] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)

  /* Every one of the three review endpoints is gated on `TeamViewer` *and* a
     flag. The role half is the same for all three, so it gates the page; the
     flag half differs, so it gates each lane. */
  const isTeamViewer = canViewTeam(user)
  const mayLeave = isTeamViewer && permits(user, 'can_approve_leave')
  const mayReg = isTeamViewer && canApproveRegularization(user)
  const mayTimesheet = isTeamViewer && permits(user, 'can_approve_timesheets')
  /* Money, unlike the three above, is not a team-viewer question: an approver
     of spending need not be anybody's manager, and finance routinely is not.
     So these two check their own flag and nothing else — the same rule the
     services enforce, rather than a stricter one invented here that would hide
     rows the server would happily have decided. */
  const mayExpense = permits(user, 'can_approve_expenses')
  const mayLoan = permits(user, 'can_approve_loans')
  /* Appraisals are assigned per review rather than by a permission flag: the
     review records the manager it was given to, and a reorganisation must not
     move somebody's appraisal to whoever manages them today. So the lane is
     fetched for any team viewer and the server returns only the ones actually
     assigned to this reader. */
  const mayReview = isTeamViewer
  const mayAnything =
    mayLeave || mayReg || mayTimesheet || mayExpense || mayLoan || mayReview

  /* The lanes fetch in parallel and fail independently. A leave outage must
     not hide the four regularizations that are also waiting. */
  const regQ = useQuery<RegRequest[]>(
    `inbox-reg:${reloadKey}`,
    () => api.get<RegRequest[]>('/regularization/review?status=pending'),
    { enabled: mayReg },
  )
  const leaveQ = useQuery<LeaveApplication[]>(
    `inbox-leave:${reloadKey}`,
    () => api.get<LeaveApplication[]>('/leave/applications/review?status=pending'),
    { enabled: mayLeave },
  )
  /* Timesheets have no "everything pending" endpoint — approval is per period,
     and `/timesheets/team` answers for exactly one. This week and last week is
     the compromise: it covers every sheet a weekly cadence can have waiting,
     and an older one is unreachable from here. See the report. */
  const thisWeek = todayISOLocal()
  const lastWeek = shiftDays(thisWeek, -7)
  const tsNowQ = useQuery<TeamSheet>(
    `inbox-ts-now:${thisWeek}:${reloadKey}`,
    () => api.get<TeamSheet>(`/timesheets/team?period=weekly&day=${thisWeek}`),
    { enabled: mayTimesheet },
  )
  const tsPrevQ = useQuery<TeamSheet>(
    `inbox-ts-prev:${lastWeek}:${reloadKey}`,
    () => api.get<TeamSheet>(`/timesheets/team?period=weekly&day=${lastWeek}`),
    { enabled: mayTimesheet },
  )
  /* Both of these do have an "everything pending" endpoint, unlike timesheets,
     so neither needs the two-week compromise above. */
  const expenseQ = useQuery<PendingClaim[]>(
    `inbox-expense:${reloadKey}`,
    () => api.get<PendingClaim[]>('/expenses/review'),
    { enabled: mayExpense },
  )
  const loanQ = useQuery<PendingLoan[]>(
    `inbox-loan:${reloadKey}`,
    () => api.get<PendingLoan[]>('/loans?status=requested'),
    { enabled: mayLoan },
  )
  /* Appraisals hang off a cycle, so "everything pending" means asking the open
     cycles. One extra call for the cycle list, then one per open cycle — in
     practice one, because companies run one round at a time. */
  const cyclesQ = useQuery<Array<{ id: string; status: string }>>(
    `inbox-cycles:${reloadKey}`,
    () => api.get('/performance/cycles'),
    { enabled: mayReview },
  )
  const openCycleIds = (cyclesQ.data ?? [])
    .filter((c) => c.status === 'open')
    .map((c) => c.id)
  const reviewQ = useQuery<PendingReview[]>(
    `inbox-review:${openCycleIds.join(',')}:${reloadKey}`,
    async () => {
      const batches = await Promise.all(
        openCycleIds.map((id) =>
          api.get<PendingReview[]>(
            `/performance/cycles/${id}/reviews?status_filter=self_submitted`,
          ),
        ),
      )
      return batches.flat()
    },
    { enabled: mayReview && openCycleIds.length > 0 },
  )

  /* Self-review is refused by all three services unless the reader is the
     owner, who is exempt because in a small company there may be nobody above
     them. Their own rows still belong in the queue — the wait is real and the
     age matters — so they are listed with an explanation instead of buttons. */
  const isOwner = user?.role === 'owner'
  const selfId = user?.id ?? ''

  const items = useMemo<InboxItem[]>(() => {
    const out: InboxItem[] = []

    for (const row of regQ.data ?? []) {
      out.push({
        key: `reg:${row.id}`,
        lane: 'regularization',
        userId: row.user_id,
        personName: row.user_name ?? 'Unknown employee',
        waitingSince: row.created_at,
        claim: (
          <>
            Asks to correct <b>{shortDate(row.date)}</b> — {askedLabel(row, tz)}.
          </>
        ),
        facts: (
          <>
            <span>
              Filed <b>{dateTime(row.created_at)}</b>
            </span>
            {filerLabel(row) && (
              <span>
                On their behalf by <b>{filerLabel(row)}</b>
              </span>
            )}
            <span>Approving rewrites the attendance record payroll reads.</span>
          </>
        ),
        quote: row.reason || null,
        decide: async (approve, note) => {
          await api.post(`/regularization/${row.id}/review`, {
            status: approve ? 'approved' : 'rejected',
            review_note: note.trim() || null,
          })
        },
        outcome: (approve) =>
          approve
            ? `Approved. ${shortDate(row.date)} has been rewritten and they have been told.`
            : `Rejected. Their attendance record is untouched and they have been told why.`,
      })
    }

    for (const row of leaveQ.data ?? []) {
      const after = row.balance_after_milli_days
      out.push({
        key: `leave:${row.id}`,
        lane: 'leave',
        userId: row.user_id,
        personName: row.user_name ?? 'Unknown employee',
        waitingSince: row.applied_at,
        claim: (
          <>
            Asks for <b>{dayLabel(row.duration_milli_days)}</b> of{' '}
            {row.leave_type_name ?? 'leave'} — {rangeLabel(row.start_date, row.end_date)}
            {row.is_half_day &&
              ` (${row.half_day_session === 'first_half' ? 'first half' : 'second half'})`}
            .
          </>
        ),
        facts: (
          <>
            <span>
              Applied <b>{dateTime(row.applied_at)}</b>
            </span>
            {after !== null && (
              <span>
                {/* D-012: milli-days are integers and stay integers. A
                    negative balance after approval is the single fact this
                    decision most often turns on, so it is stated rather than
                    left for the manager to work out. */}
                Balance afterwards <b>{leaveDays(after)}</b>
                {after < 0 && ' — this puts them into arrears'}
              </span>
            )}
            <span>Approving debits that exact figure.</span>
          </>
        ),
        quote: row.reason || null,
        decide: async (approve, note) => {
          await api.post(`/leave/applications/${row.id}/decision`, {
            approve,
            note: note.trim() || null,
          })
        },
        outcome: (approve) =>
          approve
            ? `Approved. ${dayLabel(row.duration_milli_days)} has been debited from their balance.`
            : 'Rejected. Nothing was debited, and they have been told why.',
      })
    }

    /* Two periods, deduplicated by user + period start: the current week and
       the previous one overlap only if a period boundary moves, but a queue
       that can show the same sheet twice is a queue that can be approved
       twice. */
    const seen = new Set<string>()
    for (const sheet of [tsPrevQ.data, tsNowQ.data]) {
      if (!sheet) continue
      for (const row of sheet.rows) {
        if (row.approval.status !== 'submitted') continue
        const key = `ts:${row.user_id}:${sheet.period_start}`
        if (seen.has(key)) continue
        seen.add(key)
        const t = row.totals
        out.push({
          key,
          lane: 'timesheet',
          userId: row.user_id,
          personName: row.full_name,
          /* `submitted_at` is what started the wait. The period end is the
             fallback for a row submitted before that column existed. */
          waitingSince: row.approval.submitted_at || `${sheet.period_end}T00:00:00`,
          claim: (
            <>
              Submitted <b>{mins(t.worked_minutes)}</b> for{' '}
              {shortDate(sheet.period_start)} – {shortDate(sheet.period_end)}
              {t.expected_minutes > 0 && <> against {mins(t.expected_minutes)} expected</>}.
            </>
          ),
          facts: (
            <>
              <span>
                Submitted <b>{dateTime(row.approval.submitted_at ?? null)}</b>
              </span>
              <span>
                {t.days_worked} {t.days_worked === 1 ? 'day' : 'days'} worked
              </span>
              {t.overtime_minutes > 0 && (
                <span>
                  Overtime <b>{mins(t.overtime_minutes)}</b>
                </span>
              )}
              <span>Approving freezes these totals for payroll.</span>
            </>
          ),
          quote: null,
          decide: async (approve, note) => {
            const query = `day=${sheet.period_start}&period=weekly`
            if (approve) {
              await api.post(`/timesheets/${row.user_id}/approve?${query}`, {
                note: note.trim() || null,
              })
            } else {
              await api.post(`/timesheets/${row.user_id}/reject?${query}`, { note: note.trim() })
            }
          },
          outcome: (approve) =>
            approve
              ? `Approved at ${mins(t.worked_minutes)}. That figure is frozen — later corrections will not change it.`
              : 'Sent back for changes. They have been told what to correct.',
        })
      }
    }

    for (const row of expenseQ.data ?? []) {
      out.push({
        key: `expense:${row.id}`,
        lane: 'expense',
        userId: row.user_id,
        personName: row.user_name ?? 'Unknown employee',
        waitingSince: row.submitted_at ?? row.created_at,
        claim: (
          <>
            Claims <b>{money(row.total_amount)}</b> — {row.title}
          </>
        ),
        facts: (
          <>
            <span>
              Submitted <b>{dateTime(row.submitted_at ?? row.created_at)}</b>
            </span>
            <span>
              {row.line_count} {row.line_count === 1 ? 'line' : 'lines'}
            </span>
            <span>Approving does not pay it — finance records that separately.</span>
          </>
        ),
        quote: row.note || null,
        decide: async (approve, note) => {
          await api.post(`/expenses/${row.id}/review`, {
            status: approve ? 'approved' : 'rejected',
            review_note: note.trim() || null,
          })
        },
        outcome: (approve) =>
          approve
            ? `Approved at ${money(row.total_amount)}. It now waits on finance to pay it.`
            : 'Rejected. They have been told why, and can correct and resubmit.',
      })
    }

    for (const row of loanQ.data ?? []) {
      out.push({
        key: `loan:${row.id}`,
        lane: 'loan',
        userId: row.user_id,
        personName: row.user_name ?? 'Unknown employee',
        waitingSince: row.requested_on,
        claim: (
          <>
            Asks for <b>{money(row.principal)}</b> over {row.instalment_count}{' '}
            {row.instalment_count === 1 ? 'instalment' : 'instalments'}
            {row.purpose ? ` — ${row.purpose}` : ''}.
          </>
        ),
        facts: (
          <>
            <span>
              Requested <b>{shortDate(row.requested_on)}</b>
            </span>
            <span>
              {row.interest_rate_bps === 0
                ? 'Interest free'
                : `${(row.interest_rate_bps / 100).toFixed(2)}% simple interest`}
            </span>
            {/* Sanctioning a smaller amount is routine and is not offered here:
                this queue approves as asked or refuses. The loans screen is
                where a different figure is set, because that is a negotiation
                rather than a decision. */}
            <span>Approving sanctions the full amount; disbursement is separate.</span>
          </>
        ),
        quote: row.purpose || null,
        decide: async (approve, note) => {
          await api.post(`/loans/${row.id}/review`, {
            status: approve ? 'approved' : 'rejected',
            review_note: note.trim() || null,
          })
        },
        outcome: (approve) =>
          approve
            ? `Sanctioned at ${money(row.principal)}. It is not paid out until somebody disburses it.`
            : 'Refused. They have been told why.',
      })
    }

    for (const row of reviewQ.data ?? []) {
      const rated = row.goals.filter((g) => g.self_rating !== null).length
      out.push({
        key: `review:${row.id}`,
        lane: 'performance',
        userId: row.user_id,
        personName: row.user_name ?? 'Unknown employee',
        waitingSince: row.self_submitted_at ?? row.created_at,
        claim: (
          <>
            Submitted their self-assessment for <b>{row.cycle_name ?? 'this round'}</b>.
          </>
        ),
        facts: (
          <>
            <span>
              Submitted <b>{dateTime(row.self_submitted_at ?? row.created_at)}</b>
            </span>
            <span>
              {rated} of {row.goals.length} goals rated
            </span>
            {/* Approving here passes it to HR; it does not set a rating. That
                needs the appraisal screen, where the goals and the weighted
                score are, and pretending otherwise would invite a decision made
                without reading either. */}
            <span>Rate their goals on the appraisal screen before passing it on.</span>
          </>
        ),
        quote: row.self_comment || null,
        decide: async (approve, note) => {
          await api.post(`/performance/reviews/${row.id}/decision`, {
            approve,
            note: note.trim() || null,
          })
        },
        outcome: (approve) =>
          approve
            ? 'Passed on to HR to finalise.'
            : 'Sent back. They can edit and resubmit, and have been told why.',
      })
    }

    /* Oldest first. That is the whole point of merging six queues: the thing
       that has waited longest is the thing to do next, whichever module it
       came from. A timestamp we cannot parse sorts *last*, not first — an
       unknown age is not evidence of a long wait, and NaN in a comparator
       leaves the whole list in whatever order the engine felt like. */
    const at = (i: InboxItem) => {
      const ms = instantMs(i.waitingSince)
      return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms
    }
    return out.sort((a, b) => at(a) - at(b))
  }, [regQ.data, leaveQ.data, tsNowQ.data, tsPrevQ.data, expenseQ.data,
      loanQ.data, reviewQ.data, tz])

  if (!mayAnything) {
    return (
      <div>
        <div className="page-head">
          <h1 className="page-title">Approvals</h1>
        </div>
        <section className="card">
          <EmptyState
            title="You do not approve anything"
            body={
              <>
                Approving leave, attendance corrections and timesheets are three separate
                permissions — signing off that somebody was at their desk is not the same act as
                signing off that they may spend nine days of balance. An administrator can switch
                any of them on for you on the employee record.
              </>
            }
          />
        </section>
      </div>
    )
  }

  /* A row the reader has just decided still *renders* — it has a sentence to
     show them — but it has stopped waiting, so it must stop being counted.
     Tiles and chips that keep counting decided work are the reason people stop
     believing the number at the top of a queue. */
  const outstanding = items.filter((i) => !settled[i.key])
  /* Derived from LANE_LABEL rather than spelled out: a sixth lane added to the
     type without a count here was a compile error only because every key is
     required, and building it from the label map removes the chance entirely. */
  const counts = Object.fromEntries(
    (Object.keys(LANE_LABEL) as Lane[]).map((key) => [
      key,
      outstanding.filter((i) => i.lane === key).length,
    ]),
  ) as Record<Lane, number>
  const needle = search.trim().toLowerCase()
  const inLane = lane === 'all' ? items : items.filter((i) => i.lane === lane)
  const matched = needle
    ? inLane.filter(
        (i) =>
          i.personName.toLowerCase().includes(needle) ||
          LANE_LABEL[i.lane].toLowerCase().includes(needle),
      )
    : inLane
  /* `items` is oldest-first; newest-first is the same list read backwards. */
  const visible = newestFirst ? [...matched].reverse() : matched

  const now = Date.now()
  /* `items` is already oldest-first and `filter` keeps that order. */
  const oldest = outstanding.length > 0 ? outstanding[0].waitingSince : null
  const loading =
    (mayReg && regQ.loading) ||
    (mayLeave && leaveQ.loading) ||
    (mayTimesheet && (tsNowQ.loading || tsPrevQ.loading)) ||
    (mayExpense && expenseQ.loading) ||
    (mayLoan && loanQ.loading) ||
    (mayReview && (cyclesQ.loading || reviewQ.loading))
  const refetching =
    regQ.refetching || leaveQ.refetching || tsNowQ.refetching ||
    tsPrevQ.refetching || expenseQ.refetching || loanQ.refetching ||
    reviewQ.refetching

  /* Only rows the reader can still decide are selectable: a settled row has
     nothing left to do, and their own request is not theirs to decide. */
  const decidable = (i: InboxItem) => !settled[i.key] && (isOwner || i.userId !== selfId)
  const selectable = visible.filter(decidable)
  const picked = selectable.filter((i) => selected.has(i.key))
  const allPicked = selectable.length > 0 && picked.length === selectable.length
  const lanesWaiting = (Object.keys(counts) as Lane[]).filter((k) => counts[k] > 0).length

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function settle(item: InboxItem, approved: boolean) {
    setSettled((prev) => ({ ...prev, [item.key]: { approved, message: item.outcome(approved) } }))
    setFailures((prev) => {
      const rest = { ...prev }
      delete rest[item.key]
      return rest
    })
    setSelected((prev) => {
      const next = new Set(prev)
      next.delete(item.key)
      return next
    })
  }

  /* One at a time, not in parallel: each module debits, freezes or notifies on
     its own, and a burst of simultaneous decisions against one person's balance
     is exactly the race the services were not written to expect. A failure on
     one row stops nothing — it is reported on that row and the rest proceed. */
  async function approveSelected() {
    setBulkBusy(true)
    for (const item of picked) {
      try {
        await item.decide(true, '')
        settle(item, true)
      } catch (err) {
        setFailures((prev) => ({
          ...prev,
          [item.key]: errorText(err, 'That decision could not be recorded'),
        }))
      }
    }
    setBulkBusy(false)
  }

  const laneTabs: Array<{ id: Lane; allowed: boolean }> = [
    { id: 'regularization', allowed: mayReg },
    { id: 'leave', allowed: mayLeave },
    { id: 'timesheet', allowed: mayTimesheet },
    { id: 'expense', allowed: mayExpense },
    { id: 'loan', allowed: mayLoan },
    { id: 'performance', allowed: mayReview },
  ]

  return (
    <div className="ai-page">
      {/* No page heading: the top bar already names the page, and the four
          figures say what is waiting before any sentence could. */}
      <div className="ai-kpis">
        <Kpi
          tone="brand"
          icon={<IconClock size={16} />}
          label="Waiting on you"
          value={String(outstanding.length)}
          meta={
            outstanding.length === 0 ? 'Nothing outstanding' : `Across ${lanesWaiting} queues`
          }
        />
        <Kpi
          tone={oldest && now - instantMs(oldest) > 72 * 3_600_000 ? 'bad' : 'warn'}
          icon={<IconAlert size={16} />}
          label="Longest wait"
          value={oldest ? waited(oldest, now) : '—'}
          meta={oldest ? 'Since it was filed' : 'Nobody is waiting'}
        />
        <Kpi
          tone="info"
          icon={<IconUsers size={16} />}
          label="People affected"
          value={String(new Set(outstanding.map((i) => i.userId)).size)}
          meta="Awaiting your decision"
        />
        <Kpi
          tone="good"
          icon={<IconCheck size={16} />}
          label="Decided"
          value={String(Object.keys(settled).length)}
          meta="Since this page opened"
        />
      </div>

      {/* A lane that failed says so, once, above the queue — and the queue
          still renders everything the other lanes returned. */}
      {mayReg && regQ.error && (
        <ErrorNote>Attendance corrections: {errorText(regQ.error, 'could not be loaded')}</ErrorNote>
      )}
      {mayLeave && leaveQ.error && (
        <ErrorNote>Leave requests: {errorText(leaveQ.error, 'could not be loaded')}</ErrorNote>
      )}
      {mayTimesheet && (tsNowQ.error || tsPrevQ.error) && (
        <ErrorNote>
          Timesheets: {errorText(tsNowQ.error ?? tsPrevQ.error, 'could not be loaded')}
        </ErrorNote>
      )}
      {mayExpense && expenseQ.error && (
        <ErrorNote>Expense claims: {errorText(expenseQ.error, 'could not be loaded')}</ErrorNote>
      )}
      {mayLoan && loanQ.error && (
        <ErrorNote>Loan requests: {errorText(loanQ.error, 'could not be loaded')}</ErrorNote>
      )}
      {mayReview && (cyclesQ.error || reviewQ.error) && (
        <ErrorNote>
          Appraisals: {errorText(cyclesQ.error ?? reviewQ.error, 'could not be loaded')}
        </ErrorNote>
      )}

      <section className="card ai-panel">
        {/* Lanes the reader cannot decide are absent, not shown at zero: a tab
            reading "Leave 0" is a claim about the queue, and we have no basis
            for it when the endpoint was never called. */}
        <div className="ai-toolbar">
          <div className="ai-seg" role="tablist" aria-label="Filter by type">
            <SegButton
              label="All"
              count={outstanding.length}
              on={lane === 'all'}
              onPick={() => setLane('all')}
            />
            {laneTabs
              .filter((t) => t.allowed)
              .map((t) => (
                <SegButton
                  key={t.id}
                  lane={t.id}
                  label={LANE_LABEL[t.id]}
                  count={counts[t.id]}
                  on={lane === t.id}
                  onPick={() => setLane(t.id)}
                />
              ))}
          </div>
          <div className="ai-tools">
            <label className="ai-search">
              <IconSearch size={13} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search employee"
                aria-label="Search by employee"
              />
            </label>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => setNewestFirst((v) => !v)}
              title="Change the order"
            >
              <IconFilter size={13} /> {newestFirst ? 'Newest first' : 'Oldest first'}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setSettled({})
                setFailures({})
                setSelected(new Set())
                setReloadKey((n) => n + 1)
              }}
              title="Reload every queue"
              aria-label="Refresh"
            >
              <IconReturn size={14} />
            </button>
          </div>
        </div>

        {picked.length > 0 && (
          <div className="ai-bulk">
            <span>
              <b>{picked.length}</b> selected
            </span>
            <button
              className="btn btn-sm btn-primary"
              disabled={bulkBusy}
              onClick={() => void approveSelected()}
            >
              <IconCheck size={13} /> {bulkBusy ? 'Approving…' : 'Approve selected'}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              disabled={bulkBusy}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
            <span className="ai-bulk-hint">
              Rejections need a reason, so they are made one row at a time.
            </span>
          </div>
        )}

        {loading ? (
          <Loading label="Gathering your queues…" />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<IconCheck size={22} />}
            title={
              outstanding.length === 0
                ? 'Nothing is waiting on you'
                : needle
                  ? 'No request matches that search'
                  : 'Nothing in this queue'
            }
            body={
              outstanding.length === 0 ? (
                <>
                  Attendance corrections, leave requests, timesheets, claims, loans and appraisals
                  land here the moment somebody files one.
                </>
              ) : (
                <>
                  {outstanding.length} {outstanding.length === 1 ? 'item is' : 'items are'} waiting
                  elsewhere in your queue.
                </>
              )
            }
            action={
              outstanding.length === 0 ? undefined : (
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setLane('all')
                    setSearch('')
                  }}
                >
                  Show everything
                </button>
              )
            }
          />
        ) : (
          <div className={`table-wrap${refetching ? ' refetching' : ''}`}>
            <table className="table ai-table">
              <thead>
                <tr>
                  <th className="ai-col-check">
                    <input
                      type="checkbox"
                      checked={allPicked}
                      disabled={selectable.length === 0 || bulkBusy}
                      onChange={() =>
                        setSelected(allPicked ? new Set() : new Set(selectable.map((i) => i.key)))
                      }
                      aria-label="Select every decidable row"
                    />
                  </th>
                  <th>Employee</th>
                  <th>Type</th>
                  <th>Request</th>
                  <th>Waiting</th>
                  <th className="row-actions">Action</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <QueueRow
                    key={item.key}
                    item={item}
                    now={now}
                    settled={settled[item.key]}
                    failure={failures[item.key]}
                    canDecide={isOwner || item.userId !== selfId}
                    picked={selected.has(item.key)}
                    locked={bulkBusy}
                    onToggle={() => toggle(item.key)}
                    onSettled={(approved) => settle(item, approved)}
                    onFailed={(message) =>
                      setFailures((prev) => ({ ...prev, [item.key]: message }))
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

    </div>
  )
}

/** Compact summary card: a tinted icon, the figure, and one line beneath. */
function Kpi({
  tone,
  icon,
  label,
  value,
  meta,
}: {
  tone: 'brand' | 'warn' | 'bad' | 'info' | 'good'
  icon: ReactNode
  label: string
  value: string
  meta: string
}) {
  return (
    <div className={`ai-kpi ai-kpi-${tone}`}>
      <span className="ai-kpi-icon">{icon}</span>
      <div className="ai-kpi-body">
        <div className="ai-kpi-label">{label}</div>
        <div className="ai-kpi-value">{value}</div>
        <div className="ai-kpi-meta">{meta}</div>
      </div>
    </div>
  )
}

function SegButton({
  label,
  count,
  on,
  lane,
  onPick,
}: {
  label: string
  count: number
  on: boolean
  lane?: Lane
  onPick: () => void
}) {
  return (
    <button
      role="tab"
      aria-selected={on}
      className={`ai-seg-btn${on ? ' ai-seg-on' : ''}${count === 0 && !on ? ' ai-seg-empty' : ''}`}
      onClick={onPick}
    >
      {lane && <span className={`ai-dot ai-lane-${lane}`} />}
      {label}
      <span className="ai-seg-count">{count}</span>
    </button>
  )
}

/* ----------------------------------------------------------------- row ---- */

/**
 * One request, as a table row plus an optional detail row beneath it.
 *
 * The facts a decision turns on — the balance it spends, the totals it freezes —
 * sit in the detail row rather than being dropped for a tidier table: a queue
 * that shows the request without them is a queue that approves by reflex.
 * Reject opens the same row, because a rejection needs a reason.
 */
function QueueRow({
  item,
  now,
  settled,
  failure,
  canDecide,
  picked,
  locked,
  onToggle,
  onSettled,
  onFailed,
}: {
  item: InboxItem
  now: number
  settled: Settled | undefined
  failure: string | undefined
  canDecide: boolean
  picked: boolean
  locked: boolean
  onToggle: () => void
  onSettled: (approved: boolean) => void
  onFailed: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  /* A rejection with no reason guarantees the identical request comes back
     tomorrow, and the services refuse one — so the button is disabled rather
     than allowed to fail. */
  const canReject = note.trim().length > 0
  const disabled = busy !== null || locked

  async function act(approve: boolean) {
    setBusy(approve ? 'approve' : 'reject')
    try {
      await item.decide(approve, note)
      onSettled(approve)
      setRejecting(false)
    } catch (err) {
      onFailed(errorText(err, 'That decision could not be recorded'))
    } finally {
      setBusy(null)
    }
  }

  const expanded = open || rejecting || Boolean(failure) || Boolean(settled)

  return (
    <>
      <tr className={`ai-tr${picked ? ' ai-tr-picked' : ''}${settled ? ' ai-tr-done' : ''}`}>
        <td className="ai-col-check">
          {canDecide && !settled && (
            <input
              type="checkbox"
              checked={picked}
              disabled={locked}
              onChange={onToggle}
              aria-label={`Select ${item.personName}`}
            />
          )}
        </td>
        <td>
          <Identity name={item.personName} small />
        </td>
        <td>
          <span className="badge badge-neutral ai-type">
            <span className={`ai-dot ai-lane-${item.lane}`} />
            {LANE_LABEL[item.lane]}
          </span>
        </td>
        <td className="ai-col-request">
          <div className="ai-claim">{item.claim}</div>
          {item.quote && <div className="ai-quote-line">“{item.quote}”</div>}
        </td>
        <td className="ai-col-age">
          <span className={`ai-age ${ageClass(item.waitingSince, now)}`}>
            {waited(item.waitingSince, now)}
          </span>
          <div className="muted-sm">{dateTime(item.waitingSince)}</div>
        </td>
        <td className="row-actions">
          {settled ? (
            <span className={`badge ${settled.approved ? 'badge-success' : 'badge-danger'}`}>
              {settled.approved ? 'Approved' : 'Rejected'}
            </span>
          ) : !canDecide ? (
            <span className="badge badge-neutral" title="Your own request waits for somebody above you.">
              Your request
            </span>
          ) : (
            <>
              <button
                className="btn btn-sm btn-primary ai-act"
                disabled={disabled}
                onClick={() => void act(true)}
              >
                <IconCheck size={13} /> {busy === 'approve' ? 'Approving…' : 'Approve'}
              </button>
              <button
                className={`btn btn-sm ai-act${rejecting ? ' ai-act-on' : ''}`}
                disabled={disabled}
                onClick={() => setRejecting((v) => !v)}
                title="Reject with a reason"
              >
                <IconClose size={13} /> Reject
              </button>
            </>
          )}
          <button
            className={`btn btn-sm btn-ghost ai-more${expanded ? ' ai-more-open' : ''}`}
            onClick={() => setOpen((v) => !v)}
            aria-expanded={expanded}
            aria-label="Details"
            title="Details"
          >
            <IconChevronDown size={13} />
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="ai-detail">
          <td />
          <td colSpan={5}>
            <div className="ai-facts">{item.facts}</div>
            {item.quote && <p className="ai-quote">“{item.quote}”</p>}
            {settled && <div className="notice notice-ok ai-row-msg">{settled.message}</div>}
            {!settled && !canDecide && (
              <p className="ai-note">
                This is your own request. Deciding it yourself would defeat the point of approval,
                so it waits for somebody above you — it is listed here because the wait is real.
              </p>
            )}
            {!settled && canDecide && rejecting && (
              <div className="ai-actions">
                <input
                  className="ai-reason"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={2000}
                  placeholder="Reason for rejecting — they will see this"
                  disabled={disabled}
                  autoFocus
                />
                <button
                  className="btn btn-sm btn-danger"
                  disabled={disabled || !canReject}
                  onClick={() => void act(false)}
                  title={canReject ? undefined : 'Give a reason first'}
                >
                  {busy === 'reject' ? 'Rejecting…' : 'Confirm reject'}
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={disabled}
                  onClick={() => {
                    setRejecting(false)
                    setNote('')
                  }}
                >
                  Cancel
                </button>
              </div>
            )}
            {failure && (
              <div className="ai-row-msg">
                <ErrorNote>{failure}</ErrorNote>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}
/* ------------------------------------------------------------- calendar --- */

/** Today by the browser's clock, as YYYY-MM-DD.
 *
 *  Deliberately *not* the org timezone here: `/timesheets/team` resolves the
 *  period server-side from this date, and a weekly period is seven days wide,
 *  so a few hours of offset only matters within hours of a period boundary —
 *  where the previous-week query already covers it. */
function todayISOLocal(): string {
  const now = new Date()
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

function shiftDays(iso: string, delta: number): string {
  const ms = Date.parse(`${iso}T00:00:00Z`)
  if (Number.isNaN(ms)) return iso
  return new Date(ms + delta * 86_400_000).toISOString().slice(0, 10)
}
