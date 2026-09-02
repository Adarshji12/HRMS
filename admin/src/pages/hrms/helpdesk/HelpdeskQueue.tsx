import { useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import '../../../styles/helpdesk.css'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { canViewTeam, useAuth } from '../../../lib/auth'
import { dateTime, relativeTime } from '../../../lib/format'
import type { User } from '../../../lib/types'
import { Empty, EmptyState, ErrorNote, Loading, StatTile } from '../../../components/ui'
import { IconInfo } from '../../../components/Icons'
import {
  PRIORITIES,
  PRIORITY_LABEL,
  PriorityTag,
  SourceBackLink,
  TICKET_STATUS_LABEL,
  TicketStatusPill,
  errorText,
  permits,
  type Category,
  type PublicComment,
  type Ticket,
} from './Helpdesk'

/* ---------------------------------------------------------------- types ---

   The two shapes the staff surface returns, kept as two types.

   D-026: reading an internal note takes `can_administer` **or** being this
   ticket's assignee — working the queue is not the same right. A caller
   without it gets the redacted shape back, not a 403, and the redacted shape
   simply has no count keys on it. So the queue is a mixed list on purpose and
   `counts()` below returns null rather than zero for the rows it may not read.
   Normalising the two into one interface with `comment_count?: number ?? 0` is
   the exact mistake the server went out of its way not to make. */

interface StaffCounts {
  comment_count: number
  internal_comment_count: number
}

type QueueRow = Ticket | (Ticket & StaffCounts)

interface StaffComment {
  id: string
  ticket_id: string
  author_id: string | null
  body: string
  created_at: string
  author_name: string | null
  /** May be true. This is the only comment type in the console that admits it. */
  is_internal: boolean
  author_role: string | null
}

interface RedactedDetail extends Ticket {
  comments: PublicComment[]
}
interface EntitledDetail extends Ticket, StaffCounts {
  comments: StaffComment[]
}
type QueueDetail = RedactedDetail | EntitledDetail

interface StaffCategory extends Category {
  open_ticket_count: number
  ticket_count: number
}

/**
 * The counts on one row, or null when the API did not send them.
 *
 * Absent is not zero. "0 internal notes" is an assertion about a ticket, and a
 * confident zero teaches the reader exactly as much as a confident eight — so
 * the missing case is modelled as "unknown and none of my business" and
 * rendered as such. Checked by type rather than by `in` so a future `null` on
 * the wire cannot slip through as a number either.
 */
function counts(row: QueueRow | QueueDetail): StaffCounts | null {
  const maybe = row as Partial<StaffCounts>
  if (typeof maybe.comment_count !== 'number') return null
  if (typeof maybe.internal_comment_count !== 'number') return null
  return { comment_count: maybe.comment_count, internal_comment_count: maybe.internal_comment_count }
}

/** The entitled detail shape carries the counts; the redacted one has no such key. */
function isEntitled(detail: QueueDetail): detail is EntitledDetail {
  return counts(detail) !== null
}

/* ----------------------------------------------------------------- page --- */

export default function HelpdeskQueue() {
  const { user } = useAuth()
  /* Role first, then the flag — the same order the server composes them in.
     `can_manage_helpdesk` restricts and never grants, so ticking it on an
     employee must not hand them the queue. */
  const allowed = canViewTeam(user) && permits(user, 'can_manage_helpdesk')

  const [params, setParams] = useSearchParams()
  const selected = params.get('t')

  const [scope, setScope] = useState<'all' | 'mine' | 'unassigned'>('all')
  const [status, setStatus] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [openOnly, setOpenOnly] = useState(true)

  const key = `hd-queue:${scope}:${status}:${categoryId}:${openOnly}`
  const queue = useQuery<QueueRow[]>(
    key,
    () => {
      const search = new URLSearchParams()
      if (status) search.set('status', status)
      if (categoryId) search.set('category_id', categoryId)
      if (scope === 'mine') search.set('mine_only', 'true')
      if (scope === 'unassigned') search.set('unassigned_only', 'true')
      search.set('open_only', String(openOnly))
      return api.get<QueueRow[]>(`/helpdesk/staff/tickets?${search.toString()}`)
    },
    { enabled: allowed },
  )
  const categories = useQuery<StaffCategory[]>(
    'hd-staff-categories',
    () => api.get<StaffCategory[]>('/helpdesk/categories'),
    { enabled: allowed },
  )
  const people = useQuery<User[]>('employees', () => api.get<User[]>('/admin/employees'), {
    enabled: allowed,
  })

  /* The server refuses an assignee who may not work the helpdesk, because
     being the assignee is how a person starts reading internal notes. The role
     half of that predicate is visible here; the per-person flag is not on
     `UserOut`, so a candidate the flag excludes is refused on submit with the
     server's own message rather than filtered out of this list. */
  const candidates = useMemo(
    () =>
      (people.data ?? []).filter(
        (p) => p.is_active && (p.role === 'owner' || p.role === 'admin' || p.role === 'manager'),
      ),
    [people.data],
  )

  const summary = useMemo(() => {
    const rows = queue.data ?? []
    return {
      total: rows.length,
      unassigned: rows.filter((t) => t.assigned_to === null).length,
      urgent: rows.filter((t) => t.priority === 'urgent' || t.priority === 'high').length,
      mine: user ? rows.filter((t) => t.assigned_to === user.id).length : 0,
    }
  }, [queue.data, user])

  function select(id: string | null) {
    const next = new URLSearchParams(params)
    if (id) next.set('t', id)
    else next.delete('t')
    setParams(next, { replace: true })
  }

  if (!allowed) {
    return (
      <div>
        <div className="page-head">
          <h1 className="page-title">Ticket queue</h1>
        </div>
        <section className="card">
          <EmptyState
            icon={<IconInfo size={22} />}
            title="The queue is not open to your account"
            body="Working other people's tickets needs a role that can see the team and permission to manage the helpdesk. Your own tickets are on the Helpdesk page."
          />
        </section>
      </div>
    )
  }

  if (queue.error) return <ErrorNote>{errorText(queue.error, 'Could not load the queue')}</ErrorNote>

  const rows = queue.data ?? []

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Ticket queue</h1>
          <p className="page-sub">
            Every ticket in the company, by priority then age.
          </p>
        </div>
      </div>

      <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
        <StatTile label="In this view" value={String(summary.total)} />
        <StatTile
          label="Unassigned"
          value={String(summary.unassigned)}
          meta={summary.unassigned ? 'nobody has taken these' : undefined}
          accent={summary.unassigned ? 'var(--status-warn)' : undefined}
        />
        <StatTile label="High or urgent" value={String(summary.urgent)} accent="var(--unprod)" />
        <StatTile label="Assigned to me" value={String(summary.mine)} accent="var(--brand)" />
      </div>

      <div className="filter-row">
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as 'all' | 'mine' | 'unassigned')}
          aria-label="Scope"
        >
          <option value="all">Everyone's tickets</option>
          <option value="mine">Assigned to me</option>
          <option value="unassigned">Unassigned</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {Object.entries(TICKET_STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          aria-label="Category"
        >
          <option value="">All categories</option>
          {(categories.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.open_ticket_count} open)
            </option>
          ))}
        </select>
        <label className="check-field">
          <input
            type="checkbox"
            checked={openOnly}
            disabled={status !== ''}
            onChange={(e) => setOpenOnly(e.target.checked)}
          />
          <span>Only open and in progress</span>
        </label>
        <span className="filter-count">{rows.length} shown</span>
      </div>

      <div className="hd-split">
        <section className="card" style={{ opacity: queue.refetching ? 0.6 : 1 }}>
          <div className="card-head">
            <h2 className="card-title">Queue</h2>
          </div>
          {queue.loading ? (
            <Loading />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<IconInfo size={22} />}
              title={openOnly && scope === 'all' && !status ? 'Nothing is waiting' : 'Nothing matches that view'}
              body={
                openOnly && scope === 'all' && !status
                  ? 'No open tickets. Untick “only open and in progress” to read the ones already resolved or closed.'
                  : 'Widen the filters — the ticket may be assigned to somebody else, in another category, or already closed.'
              }
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ticket</th>
                    <th>Assignee</th>
                    <th>Notes</th>
                    <th>Age</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <QueueRowView
                      key={row.id}
                      row={row}
                      selected={row.id === selected}
                      onSelect={() => select(row.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card">
          {selected ? (
            <StaffTicket
              key={selected}
              ticketId={selected}
              categories={categories.data ?? []}
              candidates={candidates}
              selfId={user?.id ?? null}
              onChanged={() => queue.reload()}
              onClosePanel={() => select(null)}
            />
          ) : (
            <Empty>Pick a ticket to triage it.</Empty>
          )}
        </section>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ row --- */

function QueueRowView({
  row,
  selected,
  onSelect,
}: {
  row: QueueRow
  selected: boolean
  onSelect: () => void
}) {
  const c = counts(row)
  return (
    <tr className={selected ? 'hd-row-selected' : undefined}>
      <td>
        <button className="hd-rowbtn" onClick={onSelect}>
          <div className="hd-subject">{row.subject}</div>
          <div className="hd-sub">
            {row.raised_by_name ?? 'Former employee'}
            {' · '}
            {row.category_name ?? 'Uncategorised'}
          </div>
        </button>
        <div className="hd-detail-meta" style={{ marginTop: 6 }}>
          <TicketStatusPill value={row.status} />
          <PriorityTag value={row.priority} />
        </div>
      </td>
      <td>{row.assigned_to_name ?? <span className="hd-muted">unassigned</span>}</td>
      <td>
        {/* Counts render only on the rows the API sent them for. A row without
            them is not a row with none — see D-026 and `counts()`. */}
        {c ? (
          <span className="hd-counts">
            <b>{c.comment_count}</b> total
            {c.internal_comment_count > 0 && (
              <>
                {' · '}
                <span className="hd-count-int">{c.internal_comment_count} internal</span>
              </>
            )}
          </span>
        ) : (
          <span className="hd-unknown" title="Not shown for this ticket">
            —
          </span>
        )}
      </td>
      <td className="hd-when">{relativeTime(row.created_at)}</td>
    </tr>
  )
}

/* --------------------------------------------------------------- detail --- */

function StaffTicket({
  ticketId,
  categories,
  candidates,
  selfId,
  onChanged,
  onClosePanel,
}: {
  ticketId: string
  categories: StaffCategory[]
  candidates: User[]
  selfId: string | null
  onChanged: () => void
  onClosePanel: () => void
}) {
  const detail = useQuery<QueueDetail>(`hd-staff-ticket:${ticketId}`, () =>
    api.get<QueueDetail>(`/helpdesk/staff/tickets/${ticketId}`),
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function mutate(run: () => Promise<unknown>, failure: string) {
    setBusy(true)
    setError(null)
    try {
      await run()
      detail.reload()
      onChanged()
    } catch (err) {
      setError(errorText(err, failure))
    } finally {
      setBusy(false)
    }
  }

  if (detail.loading) return <Loading />
  if (detail.error) return <ErrorNote>{errorText(detail.error, 'Could not load the ticket')}</ErrorNote>
  const ticket = detail.data
  if (!ticket) return <Empty>That ticket is no longer available.</Empty>

  const c = counts(ticket)
  const takeable = selfId !== null && ticket.assigned_to !== selfId

  return (
    <div className="hd-detail">
      <div className="hd-detail-head">
        <div style={{ minWidth: 0 }}>
          <h2 className="hd-detail-title">{ticket.subject}</h2>
          <div className="hd-detail-meta">
            <TicketStatusPill value={ticket.status} />
            <PriorityTag value={ticket.priority} />
            <span className="hd-when">
              raised by {ticket.raised_by_name ?? 'a former employee'}{' '}
              {relativeTime(ticket.created_at)}
            </span>
          </div>
        </div>
        <button className="btn btn-sm" onClick={onClosePanel}>
          Close panel
        </button>
      </div>

      <SourceBackLink path={`/helpdesk/staff/tickets/${ticket.id}/source`} />

      <p className="hd-body">{ticket.description}</p>

      {/* Two independent timestamps. Reopening clears `resolved_at`; a ticket
          closed as a duplicate or withdrawn by the raiser never had one. */}
      <div className="hd-facts">
        <Fact label="Category" value={ticket.category_name} none="Uncategorised" />
        <Fact label="Assignee" value={ticket.assigned_to_name} none="Nobody yet" />
        <Fact
          label="Resolved"
          value={ticket.resolved_at ? dateTime(ticket.resolved_at) : null}
          none="Not resolved"
        />
        <Fact
          label="Closed"
          value={ticket.closed_at ? dateTime(ticket.closed_at) : null}
          none="Not closed"
        />
        {c && (
          <Fact
            label="Comments"
            value={`${c.comment_count} total · ${c.internal_comment_count} internal`}
            none=""
          />
        )}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="settings-grid">
        <label className="setting">
          Status
          <select
            value={ticket.status}
            disabled={busy}
            onChange={(e) =>
              mutate(
                () => api.patch(`/helpdesk/staff/tickets/${ticket.id}`, { status: e.target.value }),
                'Could not change the status',
              )
            }
          >
            {Object.entries(TICKET_STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <span className="setting-hint">
            Resolving stamps a resolution date; closing does not. Reopening clears both.
          </span>
        </label>
        <label className="setting">
          Priority
          <select
            value={ticket.priority}
            disabled={busy}
            onChange={(e) =>
              mutate(
                () => api.patch(`/helpdesk/staff/tickets/${ticket.id}`, { priority: e.target.value }),
                'Could not change the priority',
              )
            }
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="setting">
          Category
          <select
            value={ticket.category_id ?? ''}
            disabled={busy || categories.length === 0}
            onChange={(e) => {
              const value = e.target.value
              if (!value) return
              void mutate(
                () => api.patch(`/helpdesk/staff/tickets/${ticket.id}`, { category_id: value }),
                'Could not move the ticket',
              )
            }}
          >
            <option value="">Uncategorised</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
          </select>
          <span className="setting-hint">
            {categories.length === 0
              ? 'No categories exist yet.'
              : 'A ticket cannot be moved back to uncategorised once it has a category.'}
          </span>
        </label>
        <label className="setting">
          Assignee
          <select
            value={ticket.assigned_to ?? ''}
            disabled={busy}
            onChange={(e) =>
              mutate(
                () =>
                  api.post(`/helpdesk/staff/tickets/${ticket.id}/assign`, {
                    assignee_id: e.target.value || null,
                  }),
                'Could not assign the ticket',
              )
            }
          >
            <option value="">Unassigned</option>
            {candidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name}
              </option>
            ))}
          </select>
          <span className="setting-hint">
            Only people who may work the helpdesk can be assigned — taking a ticket is what grants
            the right to read its internal notes.
          </span>
        </label>
      </div>

      <div className="hd-toolbar">
        {takeable && (
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() =>
              mutate(
                () =>
                  api.post(`/helpdesk/staff/tickets/${ticket.id}/assign`, { assignee_id: selfId }),
                'Could not take the ticket',
              )
            }
          >
            Take it
          </button>
        )}
        {ticket.status !== 'resolved' && (
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() =>
              mutate(
                () => api.post(`/helpdesk/staff/tickets/${ticket.id}/resolve`),
                'Could not resolve the ticket',
              )
            }
          >
            Mark resolved
          </button>
        )}
        {ticket.status !== 'closed' && (
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() =>
              mutate(
                () => api.post(`/helpdesk/staff/tickets/${ticket.id}/close`),
                'Could not close the ticket',
              )
            }
          >
            Close
          </button>
        )}
        {(ticket.status === 'resolved' || ticket.status === 'closed') && (
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() =>
              mutate(
                () => api.post(`/helpdesk/staff/tickets/${ticket.id}/reopen`),
                'Could not reopen the ticket',
              )
            }
          >
            Reopen
          </button>
        )}
      </div>

      <div>
        <div className="card-head">
          <h3 className="card-title">Thread</h3>
        </div>
        {isEntitled(ticket) ? (
          <StaffThread comments={ticket.comments} />
        ) : (
          <>
            <PublicThread comments={ticket.comments} />
            {/* Said plainly rather than hidden. The redacted shape is a fact
                about the reader, not about the ticket — it carries no count and
                no hint of whether there is anything to withhold, so saying so
                discloses nothing. */}
            <p className="hd-note" style={{ marginTop: 10 }}>
              You are seeing the public thread. Internal notes need an administrator, or this
              ticket assigned to you.
            </p>
          </>
        )}
      </div>

      <StaffComposer
        ticketId={ticket.id}
        onDone={() => {
          detail.reload()
          onChanged()
        }}
      />
    </div>
  )
}

function Fact({ label, value, none }: { label: string; value: string | null; none: string }) {
  return (
    <div className="hd-fact">
      <span className="hd-fact-label">{label}</span>
      <span className={value ? 'hd-fact-value' : 'hd-fact-none'}>{value ?? none}</span>
    </div>
  )
}

/* --------------------------------------------------------------- thread --- */

/** The redacted thread. Structurally identical to the employee's, and it never
 *  reads `is_internal` — the type it is given does not carry one. */
function PublicThread({ comments }: { comments: PublicComment[] }) {
  if (comments.length === 0) return <Empty>Nothing has been said on this ticket yet.</Empty>
  return (
    <div className="hd-thread">
      {comments.map((comment) => (
        <article className="hd-comment" key={comment.id}>
          <div className="hd-comment-head">
            <span className="hd-comment-who">{comment.author_name ?? 'Former employee'}</span>
            <span className="hd-comment-when">{dateTime(comment.created_at)}</span>
          </div>
          <div className="hd-comment-body">{comment.body}</div>
        </article>
      ))}
    </div>
  )
}

/** The entitled thread. The only component in the console that renders an
 *  internal note, and it is reachable only from this page. */
function StaffThread({ comments }: { comments: StaffComment[] }) {
  if (comments.length === 0) return <Empty>Nothing has been said on this ticket yet.</Empty>
  return (
    <div className="hd-thread">
      {comments.map((comment) => (
        <article
          className={`hd-comment${comment.is_internal ? ' hd-internal' : ''}`}
          key={comment.id}
        >
          <div className="hd-comment-head">
            <span className="hd-comment-who">{comment.author_name ?? 'Former employee'}</span>
            {comment.author_role && <span className="hd-comment-role">{comment.author_role}</span>}
            {comment.is_internal && <span className="hd-internal-tag">Internal</span>}
            <span className="hd-comment-when">{dateTime(comment.created_at)}</span>
          </div>
          <div className="hd-comment-body">{comment.body}</div>
        </article>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------- composer --- */

/**
 * A staff comment, with the audience stated every time.
 *
 * `is_internal` is required by the request schema with **no default**, and this
 * form does not supply one either. Both defaults are wrong: public leaks the
 * note the one time somebody forgets the toggle, internal buries a real answer
 * the employee is waiting for. So the submit stays disabled until an audience
 * is picked, and nothing is pre-selected.
 *
 * The internal option is offered to every staff caller rather than hidden from
 * the ones D-026 excludes: entitlement is the server's decision, it is refused
 * with a 403 carrying a sentence written for exactly this case, and re-deriving
 * it in the browser would give the console a second opinion about who may read
 * a grievance.
 */
function StaffComposer({ ticketId, onDone }: { ticketId: string; onDone: () => void }) {
  const [body, setBody] = useState('')
  const [audience, setAudience] = useState<'public' | 'internal' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (audience === null) return
    setBusy(true)
    setError(null)
    try {
      await api.post(`/helpdesk/staff/tickets/${ticketId}/comments`, {
        body: body.trim(),
        is_internal: audience === 'internal',
      })
      setBody('')
      setAudience(null)
      onDone()
    } catch (err) {
      setError(errorText(err, 'Could not post the comment'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="hd-composer" onSubmit={submit}>
      {error && <ErrorNote>{error}</ErrorNote>}
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        maxLength={10000}
        placeholder="Write the reply, or the note."
        aria-label="Comment body"
      />
      <div className="hd-audience" role="radiogroup" aria-label="Who can read this">
        <label className="hd-aud">
          <input
            type="radio"
            name="audience"
            checked={audience === 'public'}
            onChange={() => setAudience('public')}
          />
          <span>
            <span className="hd-aud-label">Reply to the employee</span>
            <span className="hd-aud-hint">
              Appears on their ticket and they are notified. This is an answer.
            </span>
          </span>
        </label>
        <label className="hd-aud">
          <input
            type="radio"
            name="audience"
            checked={audience === 'internal'}
            onChange={() => setAudience('internal')}
          />
          <span>
            <span className="hd-aud-label">Internal note</span>
            <span className="hd-aud-hint">
              Never shown to the employee. Needs an administrator, or this ticket assigned to you.
            </span>
          </span>
        </label>
      </div>
      <div>
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || body.trim() === '' || audience === null}
        >
          {busy ? 'Posting…' : 'Post comment'}
        </button>
        {audience === null && (
          <span className="hd-unknown" style={{ marginLeft: 10 }}>
            Choose who can read this to continue.
          </span>
        )}
      </div>
    </form>
  )
}
