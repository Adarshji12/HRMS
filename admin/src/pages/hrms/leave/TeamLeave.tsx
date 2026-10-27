import { useMemo, useState, type ReactNode } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { canViewTeam, useAuth } from '../../../lib/auth'
import { dateTime, shortDate, todayISO } from '../../../lib/format'
import { Empty, EmptyState, ErrorNote, Identity, Loading, StatTile } from '../../../components/ui'
import {
  StatusPill,
  dayLabel,
  days,
  errorText,
  overlaps,
  rangeLabel,
  type LeaveApplication,
  type LeaveStatus,
} from './MyLeave'
import '../../../styles/leave.css'

/**
 * The leave approvals queue for this manager's reporting subtree.
 *
 * Scope is the server's: `/leave/applications/review` filters by
 * `hierarchy.visible_user_ids`, which is the one answer in this codebase to
 * "whose data may this manager see". Nothing here re-derives it.
 */

/* `can_approve_leave` is a real column on `users` and it is what
   `require_leave_approver` gates this page's endpoints on. It is **not** on
   `UserOut` (app/schemas/common.py), so `/auth/me` never sends it and it is not
   on `lib/types.ts` either — see the report. Read it off the auth user anyway,
   so the page starts working the moment the lead adds the field, and fall back
   to the role check meanwhile.

   Permission flags only ever restrict, so the fallback cannot widen anyone's
   access: the server still refuses a manager whose flag is off, and it refuses
   with a sentence we render. */
function canApproveLeave(user: unknown): boolean {
  const flag = (user as { can_approve_leave?: unknown } | null)?.can_approve_leave
  if (typeof flag === 'boolean') return flag
  return canViewTeam(user as Parameters<typeof canViewTeam>[0])
}

type QueueView = Extract<LeaveStatus, 'pending' | 'approved' | 'rejected'>

const VIEWS: Array<{ id: QueueView; label: string }> = [
  { id: 'pending', label: 'Awaiting you' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
]

export default function TeamLeave() {
  const { user } = useAuth()
  const [view, setView] = useState<QueueView>('pending')
  const [reloadKey, setReloadKey] = useState(0)
  const [notice, setNotice] = useState<ReactNode>(null)

  const mayApprove = canApproveLeave(user)

  const queue = useQuery<LeaveApplication[]>(
    `leave-review:${view}:${reloadKey}`,
    () => api.get<LeaveApplication[]>(`/leave/applications/review?status=${view}`),
    { enabled: mayApprove },
  )
  /* Context, not content: to decide one request a manager has to know who else
     on the team is already off in the same window. The same endpoint answers
     it — same scope, same rules — so there is no second definition of "the
     team" on this page. */
  const booked = useQuery<LeaveApplication[]>(
    `leave-review-approved:${reloadKey}`,
    () => api.get<LeaveApplication[]>('/leave/applications/review?status=approved'),
    { enabled: mayApprove },
  )

  const pendingRows = view === 'pending' ? queue.data : undefined
  const cover = useMemo(
    () => [...(booked.data ?? []), ...(pendingRows ?? [])],
    [booked.data, pendingRows],
  )

  if (!mayApprove) {
    return (
      <div>
        <div className="page-head">
          <h1 className="page-title">Team Leave</h1>
        </div>
        <section className="card">
          <EmptyState
            title="You do not approve leave"
            body={
              <>
                Approving leave is a separate permission from approving timesheets — signing off
                that somebody was at their desk is not the same act as signing off that they may
                spend nine days of balance. An administrator can switch it on for you on the
                employee record.
              </>
            }
          />
        </section>
      </div>
    )
  }

  if (queue.error) return <ErrorNote>{errorText(queue.error)}</ErrorNote>
  if (queue.loading || !queue.data) return <Loading />

  const rows = queue.data
  const oldest = rows.reduce<string | null>(
    (acc, row) => (acc === null || row.applied_at < acc ? row.applied_at : acc),
    null,
  )
  const requested = rows.reduce((sum, row) => sum + row.duration_milli_days, 0)
  const wouldGoNegative = rows.filter(
    (row) => row.balance_after_milli_days !== null && row.balance_after_milli_days < 0,
  ).length

  return (
    <div>
      <div className="page-head" style={{ justifyContent: 'flex-end' }}>
        <div className="ts-toggle" role="group" aria-label="Queue">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={`ts-toggle-btn ${view === v.id ? 'ts-toggle-on' : ''}`}
              onClick={() => { setView(v.id); setNotice(null) }}
              aria-pressed={view === v.id}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {notice && <div className="notice notice-ok" style={{ marginBottom: 14 }}>{notice}</div>}

      {view === 'pending' && (
        <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
          <StatTile label="Awaiting you" value={String(rows.length)} meta={rows.length ? 'decide these' : 'queue is clear'} />
          <StatTile label="Days requested" value={days(requested)} meta="frozen at apply time" />
          <StatTile
            label="Oldest request"
            value={oldest ? dateTime(oldest).split(',')[0] : '—'}
            meta={oldest ? 'still waiting' : 'nothing waiting'}
          />
          <StatTile
            label="Would go negative"
            value={String(wouldGoNegative)}
            meta={wouldGoNegative ? 'approving takes them into arrears' : 'all within balance'}
            accent={wouldGoNegative ? 'var(--unprod)' : undefined}
          />
        </div>
      )}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">
            {view === 'pending' ? 'Requests' : view === 'approved' ? 'Approved leave' : 'Rejected requests'}
          </h2>
          <span className="card-note">{rows.length} in your scope</span>
        </div>

        {rows.length === 0 ? (
          <Empty>
            {view === 'pending'
              ? 'Nothing is waiting on you. New requests from anyone reporting to you land here as soon as they are filed.'
              : view === 'approved'
                ? 'Nobody in your team has approved leave on record.'
                : 'You have not rejected anything.'}
          </Empty>
        ) : (
          <div className={`lv-queue${queue.refetching ? ' refetching' : ''}`}>
            {rows.map((row) => (
              <QueueItem
                key={row.id}
                application={row}
                cover={cover}
                /* Self-approval defeats the point of approval, and here it
                   spends a balance. The owner is exempt because in a small
                   company there may be nobody above them — the server draws
                   the line in exactly the same place. */
                decidable={
                  view === 'pending' && (row.user_id !== user?.id || user?.role === 'owner')
                }
                selfFiled={row.user_id === user?.id && user?.role !== 'owner'}
                onDecided={(message) => {
                  setNotice(message)
                  setReloadKey((n) => n + 1)
                }}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

/* ----------------------------------------------------------------- item --- */

function QueueItem({
  application,
  cover,
  decidable,
  selfFiled,
  onDecided,
}: {
  application: LeaveApplication
  cover: LeaveApplication[]
  decidable: boolean
  selfFiled: boolean
  onDecided: (message: ReactNode) => void
}) {
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const after = application.balance_after_milli_days
  const negative = after !== null && after < 0

  /* Everyone else in scope whose leave touches this window. Approved leave is
     cover already lost; another pending request is a decision this one should
     probably not be made in isolation from. */
  const clashes = useMemo(
    () =>
      cover
        .filter(
          (other) =>
            other.id !== application.id &&
            other.user_id !== application.user_id &&
            overlaps(application.start_date, application.end_date, other.start_date, other.end_date),
        )
        .sort((a, b) => a.start_date.localeCompare(b.start_date)),
    [cover, application],
  )

  async function decide(approve: boolean) {
    if (!approve && !note.trim()) return
    setBusy(approve ? 'approve' : 'reject')
    setError(null)
    try {
      const updated = await api.post<LeaveApplication>(
        `/leave/applications/${application.id}/decision`,
        { approve, note: note.trim() || null },
      )
      onDecided(
        approve ? (
          <>
            <b>Approved</b> {dayLabel(updated.duration_milli_days)} for{' '}
            {updated.user_name ?? 'that employee'} ({rangeLabel(updated.start_date, updated.end_date)}).
            Their balance has been debited by that exact figure.
          </>
        ) : (
          <>
            <b>Rejected</b> {updated.user_name ?? 'that request'}’s{' '}
            {rangeLabel(updated.start_date, updated.end_date)}. Nothing was debited — a rejection
            never spends balance, so there is nothing to credit back. They have been told why.
          </>
        ),
      )
    } catch (err) {
      setError(errorText(err, 'Could not record that decision'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="lv-item">
      <div className="lv-item-head">
        <Identity
          name={application.user_name ?? 'Unknown employee'}
          meta={
            <>
              {application.leave_type_name ?? 'Leave'} ·{' '}
              <b>{rangeLabel(application.start_date, application.end_date)}</b>
              {application.is_half_day && (
                <>
                  {' '}
                  ({application.half_day_session === 'first_half' ? 'first half' : 'second half'})
                </>
              )}
            </>
          }
        />
        <StatusPill status={application.status} />
      </div>

      <div className="lv-item-facts" style={{ marginTop: 8 }}>
        <span className="lv-fact">
          Costs <b>{dayLabel(application.duration_milli_days)}</b>
          <span className="lv-sub">frozen when they applied</span>
        </span>
        {after !== null && (
          <span className="lv-fact">
            Left afterwards{' '}
            <b className={negative ? 'lv-after-bad' : 'lv-after-ok'}>{days(after)}</b>
            <span className="lv-sub">
              {negative ? 'approving puts them into arrears' : 'in this leave type'}
            </span>
          </span>
        )}
        <span className="lv-fact">
          Filed <b>{dateTime(application.applied_at)}</b>
        </span>
        {application.status === 'approved' && (
          <span className="lv-fact">
            {application.debited_at ? 'Debited' : 'Approved but not yet debited'}
            {application.reviewed_by_name && <span className="lv-sub">by {application.reviewed_by_name}</span>}
          </span>
        )}
      </div>

      {application.reason && (
        <p className="lv-note" style={{ margin: '8px 0 0' }}>
          “{application.reason}”
        </p>
      )}
      {application.status === 'rejected' && application.review_note && (
        <p className="lv-note" style={{ margin: '8px 0 0' }}>
          <b>Your reason:</b> {application.review_note}
        </p>
      )}

      {decidable && (
        <div className={`lv-clash${clashes.length === 0 ? ' lv-clash-clear' : ''}`}>
          {clashes.length === 0 ? (
            <>Nobody else in your team is off during {rangeLabel(application.start_date, application.end_date)}.</>
          ) : (
            <>
              <b>
                {clashes.length} other {clashes.length === 1 ? 'person is' : 'people are'} off in
                the same window.
              </b>
              <div className="lv-chips">
                {clashes.map((other) => (
                  <span className="badge" key={other.id}>
                    {other.user_name ?? 'Someone'} · {rangeLabel(other.start_date, other.end_date)}
                    {other.status === 'pending' && ' (also awaiting you)'}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {selfFiled && application.status === 'pending' && (
        <div className="lv-clash" style={{ marginTop: 10 }}>
          This is your own request. You cannot decide it — somebody else has to, because approval
          spends a balance.
        </div>
      )}

      {decidable && (
        <div className="lv-decide">
          {error && <ErrorNote>{error}</ErrorNote>}
          {rejecting && (
            <label className="setting">
              Why are you rejecting it?{' '}
              <span className="setting-hint">
                Required. The employee is entitled to the reason, and an unexplained rejection is
                a helpdesk ticket every time.
              </span>
              <textarea
                className="set-textarea"
                value={note}
                maxLength={2000}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Two people already off that week; can you move it to the following Monday?"
              />
            </label>
          )}
          {!rejecting && (
            <label className="setting">
              Note <span className="setting-hint">Optional on an approval; the employee sees it.</span>
              <input value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
            </label>
          )}
          <div className="lv-actions">
            <button
              className="btn btn-primary btn-sm"
              disabled={busy !== null || rejecting}
              onClick={() => decide(true)}
            >
              {busy === 'approve'
                ? 'Approving…'
                : `Approve — debit ${dayLabel(application.duration_milli_days)}`}
            </button>
            {rejecting ? (
              <>
                <button
                  className="btn btn-sm"
                  disabled={busy !== null || !note.trim()}
                  onClick={() => decide(false)}
                >
                  {busy === 'reject' ? 'Rejecting…' : 'Confirm rejection'}
                </button>
                <button className="btn btn-sm btn-ghost" disabled={busy !== null} onClick={() => setRejecting(false)}>
                  Back
                </button>
              </>
            ) : (
              <button className="btn btn-sm btn-ghost" disabled={busy !== null} onClick={() => setRejecting(true)}>
                Reject…
              </button>
            )}
          </div>
          <p className="lv-sub" style={{ margin: 0 }}>
            Rejecting is not withdrawing. Nothing has been debited yet, so a rejection simply
            releases the {dayLabel(application.duration_milli_days)} this request is holding;
            only the employee — or an administrator — can withdraw leave that has already been
            approved and debited.
          </p>
        </div>
      )}

      {application.status === 'approved' && application.end_date >= todayISO() && (
        <p className="lv-sub" style={{ marginTop: 8 }}>
          Starts {shortDate(application.start_date)}. If they withdraw it you will be told —
          the credit-back uses the same frozen figure that was debited.
        </p>
      )}
    </div>
  )
}
