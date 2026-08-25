import { useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import '../../../styles/helpdesk.css'
import { api, ApiError } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import type { User } from '../../../lib/types'
import { dateTime, relativeTime } from '../../../lib/format'
import { Empty, EmptyState, ErrorNote, Loading } from '../../../components/ui'
import { IconInfo } from '../../../components/Icons'

/* ---------------------------------------------------------------- types ---
   Page-local, mirroring app/schemas/helpdesk.py. The audience split in that
   file is reproduced here rather than flattened: there is no shared `Comment`
   interface with an optional `is_internal`, because a single type is how the
   internal note eventually renders on the employee's screen. */

export interface Ticket {
  id: string
  subject: string
  description: string
  status: string
  priority: string
  category_id: string | null
  raised_by: string | null
  assigned_to: string | null
  created_at: string
  /** Cleared when a ticket is reopened. Not a synonym for `closed_at`. */
  resolved_at: string | null
  /** A ticket can be closed without ever having been resolved. */
  closed_at: string | null
  source_module: string | null
  source_ref: string | null
  category_name: string | null
  raised_by_name: string | null
  assigned_to_name: string | null
}

/**
 * A comment the raiser is allowed to read.
 *
 * `is_internal` is intentionally **not** on this interface even though the
 * server sends it as a literal `false`. Nothing on an employee-facing page has
 * any business branching on it, and a field nobody declared is a field nobody
 * can accidentally render a badge from.
 */
export interface PublicComment {
  id: string
  ticket_id: string
  author_id: string | null
  body: string
  created_at: string
  author_name: string | null
}

/** `TicketDetailOut`. No comment counts, by design — see D-026. */
interface TicketDetail extends Ticket {
  comments: PublicComment[]
}

export interface Category {
  id: string
  name: string
  description: string | null
  default_assignee_role: string | null
  is_active: boolean
}

/** `SourceLinkOut`. Carries no reason — see D-019 and `SourceBackLink`. */
export interface SourceLink {
  module: string | null
  ref: string | null
  available: boolean
  label: string | null
}

export const TICKET_STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
}

export const PRIORITY_LABEL: Record<string, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
}

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

/**
 * A 403 or 409 here may carry a typed body — `{reason, message}`. `api.ts`
 * flattens a non-string `detail` to JSON text, so unwrap it and render the
 * sentence the server wrote rather than a raw status code.
 */
export function errorText(err: unknown, fallback: string): string {
  const raw = err instanceof ApiError || err instanceof Error ? err.message : String(err ?? '')
  if (!raw) return fallback
  if (raw.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { message?: unknown; reason?: unknown }
      if (typeof parsed.message === 'string') return parsed.message
      if (typeof parsed.reason === 'string') return parsed.reason
    } catch {
      /* Not JSON after all — show what we were given. */
    }
  }
  return raw
}

/**
 * `can_manage_helpdesk` (D-002) is not on `UserOut` yet, so `/auth/me` does not
 * return it and it reads `undefined` here. The flags **restrict, never grant**,
 * so absent means "not restricted"; the role check beside it still gates the
 * surface, and the server refuses regardless. Widening `UserOut` later makes
 * this start honouring the flag with no change at the call sites.
 */
export function permits(user: User | null, flag: string): boolean {
  if (!user) return false
  return (user as unknown as Record<string, unknown>)[flag] !== false
}

export function TicketStatusPill({ value }: { value: string }) {
  return <span className={`hd-pill hd-${value}`}>{TICKET_STATUS_LABEL[value] ?? value}</span>
}

export function PriorityTag({ value }: { value: string }) {
  return (
    <span className={`hd-prio hd-prio-${value}`}>{PRIORITY_LABEL[value] ?? value} priority</span>
  )
}

/**
 * The D-019 back-link.
 *
 * A ticket may point at the thing it was raised from. The pointer is not a
 * foreign key and never will be, so the row it names may be gone, may belong
 * to another tenant, or may simply be none of this reader's business — and all
 * three render **identically**, as "linked item unavailable". No tooltip, no
 * second style, no reason in the copy. Distinguishing them is precisely what
 * turns the link into an existence oracle, which is the failure D-019 exists to
 * prevent. The endpoint never 500s on a dangling ref either; it answers
 * `available: false` and this renders that.
 */
export function SourceBackLink({ path }: { path: string }) {
  const link = useQuery<SourceLink>(path, () => api.get<SourceLink>(path))
  const data = link.data
  /* Nothing to render while loading, on error, or when the ticket carries no
     back-link at all. An error here is decoration failing, not the page. */
  if (!data || !data.module) return null
  return (
    <div className="hd-source">
      <IconInfo size={14} />
      <span className="hd-source-mod">{data.module}</span>
      {data.available && data.label ? (
        <span>{data.label}</span>
      ) : (
        <span className="hd-source-out">linked item unavailable</span>
      )}
    </div>
  )
}

/* ----------------------------------------------------------------- page --- */

export default function Helpdesk() {
  const [params, setParams] = useSearchParams()
  const selected = params.get('t')
  /* A deep link from another module: "dispute this rejection" arrives as
     ?source_module=regularization&source_ref=<uuid>. Both or neither — the
     server rejects a half-filled pair with a 422 naming the field. */
  const sourceModule = params.get('source_module')
  const sourceRef = params.get('source_ref')

  const [raising, setRaising] = useState(sourceModule !== null && sourceRef !== null)
  const [openOnly, setOpenOnly] = useState(false)
  const [status, setStatus] = useState('')

  const key = `my-tickets:${status}:${openOnly}`
  const tickets = useQuery<Ticket[]>(key, () => {
    const query = status ? `?status=${status}` : openOnly ? '?open_only=true' : ''
    return api.get<Ticket[]>(`/helpdesk/tickets${query}`)
  })
  const categories = useQuery<Category[]>('hd-categories', () =>
    api.get<Category[]>('/helpdesk/categories'),
  )

  const counts = useMemo(() => {
    const all = tickets.data ?? []
    return {
      total: all.length,
      open: all.filter((t) => t.status === 'open' || t.status === 'in_progress').length,
    }
  }, [tickets.data])

  function select(id: string | null) {
    const next = new URLSearchParams(params)
    if (id) next.set('t', id)
    else next.delete('t')
    /* The source pair is a one-shot prefill for the raise form. Dropping it on
       navigation stops a stale ref riding along into an unrelated ticket. */
    next.delete('source_module')
    next.delete('source_ref')
    setParams(next, { replace: true })
  }

  if (tickets.error) {
    return <ErrorNote>{errorText(tickets.error, 'Could not load your tickets')}</ErrorNote>
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Helpdesk</h1>
          <p className="page-sub">
            Raise a request with HR or IT and follow it through. You see your own tickets and the
            replies on them; nobody else's ticket is reachable from here.
          </p>
        </div>
        <div className="head-actions">
          <button className="btn btn-primary" onClick={() => setRaising((v) => !v)}>
            {raising ? 'Cancel' : 'Raise a ticket'}
          </button>
        </div>
      </div>

      {raising && (
        <RaiseTicket
          categories={categories.data ?? []}
          sourceModule={sourceModule}
          sourceRef={sourceRef}
          onCancel={() => setRaising(false)}
          onDone={(id) => {
            setRaising(false)
            tickets.reload()
            select(id)
          }}
        />
      )}

      <div className="filter-row">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {Object.entries(TICKET_STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
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
          <span>Only the ones still moving</span>
        </label>
        <span className="filter-count">
          {counts.open} open of {counts.total}
        </span>
      </div>

      <div className="hd-split">
        <section className="card" style={{ opacity: tickets.refetching ? 0.6 : 1 }}>
          <div className="card-head">
            <h2 className="card-title">My tickets</h2>
          </div>
          {tickets.loading ? (
            <Loading />
          ) : (tickets.data ?? []).length === 0 ? (
            <EmptyState
              icon={<IconInfo size={22} />}
              title={status || openOnly ? 'Nothing matches that filter' : 'You have not raised a ticket'}
              body={
                status || openOnly
                  ? 'Clear the filter to see everything you have raised.'
                  : 'Payroll query, a laptop that will not start, a leave balance that looks wrong — raise it here and it lands in the HR or IT queue with a record of what was said.'
              }
              action={
                !status && !openOnly ? (
                  <button className="btn btn-primary" onClick={() => setRaising(true)}>
                    Raise your first ticket
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Subject</th>
                    <th>Status</th>
                    <th>Raised</th>
                  </tr>
                </thead>
                <tbody>
                  {(tickets.data ?? []).map((ticket) => (
                    <tr key={ticket.id} className={ticket.id === selected ? 'hd-row-selected' : undefined}>
                      <td>
                        <button className="hd-rowbtn" onClick={() => select(ticket.id)}>
                          <div className="hd-subject">{ticket.subject}</div>
                          <div className="hd-sub">
                            {ticket.category_name ?? 'Uncategorised'}
                            {' · '}
                            {PRIORITY_LABEL[ticket.priority] ?? ticket.priority}
                          </div>
                        </button>
                      </td>
                      <td>
                        <TicketStatusPill value={ticket.status} />
                      </td>
                      <td className="hd-when">{relativeTime(ticket.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card">
          {selected ? (
            <MyTicket
              key={selected}
              ticketId={selected}
              onChanged={() => tickets.reload()}
              onClose={() => select(null)}
            />
          ) : (
            <Empty>Pick a ticket to read the replies on it.</Empty>
          )}
        </section>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- raise --- */

function RaiseTicket({
  categories,
  sourceModule,
  sourceRef,
  onCancel,
  onDone,
}: {
  categories: Category[]
  sourceModule: string | null
  sourceRef: string | null
  onCancel: () => void
  onDone: (id: string) => void
}) {
  const [form, setForm] = useState({
    subject: '',
    description: '',
    category_id: '',
    priority: 'normal',
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const linked = sourceModule !== null && sourceRef !== null

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const created = await api.post<Ticket>('/helpdesk/tickets', {
        subject: form.subject.trim(),
        description: form.description.trim(),
        category_id: form.category_id || null,
        priority: form.priority,
        /* Both or neither. The server refuses a ref the raiser cannot already
           see, so a link that does not belong to them fails at write time
           rather than becoming a probe for which ids exist. */
        source_module: linked ? sourceModule : null,
        source_ref: linked ? sourceRef : null,
      })
      onDone(created.id)
    } catch (err) {
      setError(errorText(err, 'Could not raise the ticket'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" style={{ marginBottom: 16 }} onSubmit={submit}>
      <div className="card-head">
        <h2 className="card-title">Raise a ticket</h2>
      </div>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {linked && (
        <div className="hd-source" style={{ marginBottom: 12 }}>
          <IconInfo size={14} />
          <span className="hd-source-mod">{sourceModule}</span>
          <span>This ticket will be linked back to the item you came from.</span>
        </div>
      )}

      <div className="settings-grid">
        <label className="setting" style={{ gridColumn: '1 / -1' }}>
          Subject
          <input
            value={form.subject}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
            maxLength={300}
            placeholder="Laptop will not boot after the update"
            required
            autoFocus
          />
        </label>
        <label className="setting">
          Category
          <select
            value={form.category_id}
            onChange={(e) => setForm({ ...form, category_id: e.target.value })}
          >
            <option value="">Not sure — let triage decide</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <span className="setting-hint">
            {categories.length === 0
              ? 'No categories set up yet. Leave it blank and somebody will route it.'
              : 'Picking the right one routes it to the people who handle it.'}
          </span>
        </label>
        <label className="setting">
          Priority
          <select
            value={form.priority}
            onChange={(e) => setForm({ ...form, priority: e.target.value })}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
          <span className="setting-hint">Staff may change this when they triage it.</span>
        </label>
        <label className="setting" style={{ gridColumn: '1 / -1' }}>
          What happened
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            rows={5}
            maxLength={20000}
            placeholder="What you expected, what happened instead, and anything you already tried."
            required
          />
        </label>
      </div>

      <div className="btn-group" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Raising…' : 'Raise ticket'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/* --------------------------------------------------------------- detail --- */

function MyTicket({
  ticketId,
  onChanged,
  onClose,
}: {
  ticketId: string
  onChanged: () => void
  onClose: () => void
}) {
  const detail = useQuery<TicketDetail>(`hd-ticket:${ticketId}`, () =>
    api.get<TicketDetail>(`/helpdesk/tickets/${ticketId}`),
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (detail.loading) return <Loading />
  if (detail.error) return <ErrorNote>{errorText(detail.error, 'Could not load the ticket')}</ErrorNote>
  const ticket = detail.data
  if (!ticket) return <Empty>That ticket is no longer available.</Empty>

  async function act(path: string, failure: string) {
    setBusy(true)
    setError(null)
    try {
      await api.post(path)
      detail.reload()
      onChanged()
    } catch (err) {
      setError(errorText(err, failure))
    } finally {
      setBusy(false)
    }
  }

  const isClosed = ticket.status === 'closed'

  return (
    <div className="hd-detail">
      <div className="hd-detail-head">
        <div style={{ minWidth: 0 }}>
          <h2 className="hd-detail-title">{ticket.subject}</h2>
          <div className="hd-detail-meta">
            <TicketStatusPill value={ticket.status} />
            <PriorityTag value={ticket.priority} />
            <span className="hd-when">raised {relativeTime(ticket.created_at)}</span>
          </div>
        </div>
        <button className="btn btn-sm" onClick={onClose}>
          Close panel
        </button>
      </div>

      <SourceBackLink path={`/helpdesk/tickets/${ticket.id}/source`} />

      <p className="hd-body">{ticket.description}</p>

      {/* Two timestamps, two facts. `resolved_at` is cleared when a ticket is
          reopened, and `closed_at` is separate because a ticket can be closed
          without ever having been resolved — a duplicate, or one the raiser
          withdrew. Folding them into one "finished on" line would report a fix
          that nobody delivered. */}
      <div className="hd-facts">
        <Fact label="Category" value={ticket.category_name} none="Uncategorised" />
        <Fact label="Handled by" value={ticket.assigned_to_name} none="Not picked up yet" />
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
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="hd-toolbar">
        {ticket.status === 'resolved' && (
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() => act(`/helpdesk/tickets/${ticket.id}/reopen`, 'Could not reopen the ticket')}
          >
            This is not fixed — reopen
          </button>
        )}
        {!isClosed && (
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() => {
              if (!window.confirm('Withdraw this ticket? It closes without being resolved.')) return
              void act(`/helpdesk/tickets/${ticket.id}/close`, 'Could not close the ticket')
            }}
          >
            Withdraw
          </button>
        )}
      </div>

      <div>
        <div className="card-head">
          <h3 className="card-title">Replies</h3>
        </div>
        {ticket.comments.length === 0 ? (
          <Empty>No replies yet. You will get a notification when somebody answers.</Empty>
        ) : (
          <div className="hd-thread">
            {ticket.comments.map((comment) => (
              /* Every comment reaching this page is a public one — the server's
                 employee-facing type pins the flag to `false` and raises rather
                 than serialising anything else. So there is no badge, no
                 filter and no toggle here: there is nothing to distinguish. */
              <article className="hd-comment" key={comment.id}>
                <div className="hd-comment-head">
                  <span className="hd-comment-who">{comment.author_name ?? 'Former colleague'}</span>
                  <span className="hd-comment-when">{dateTime(comment.created_at)}</span>
                </div>
                <div className="hd-comment-body">{comment.body}</div>
              </article>
            ))}
          </div>
        )}
      </div>

      {isClosed ? (
        <p className="hd-note">
          This ticket is closed. Raise a new one to continue the conversation.
        </p>
      ) : (
        <ReplyBox
          ticketId={ticket.id}
          onDone={() => {
            detail.reload()
            onChanged()
          }}
        />
      )}
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

/**
 * The employee's reply box.
 *
 * There is no audience control here and there must never be one. The request
 * schema behind this call has no `is_internal` field and forbids extras, so an
 * employee cannot author an internal note even by hand — this form simply has
 * nothing to offer that would correspond to one.
 */
function ReplyBox({ ticketId, onDone }: { ticketId: string; onDone: () => void }) {
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post(`/helpdesk/tickets/${ticketId}/comments`, { body: body.trim() })
      setBody('')
      onDone()
    } catch (err) {
      setError(errorText(err, 'Could not post your reply'))
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
        rows={3}
        maxLength={10000}
        placeholder="Add anything that would help, or answer a question they asked."
        aria-label="Your reply"
      />
      <div>
        <button className="btn btn-primary btn-sm" disabled={busy || body.trim() === ''}>
          {busy ? 'Sending…' : 'Send reply'}
        </button>
      </div>
    </form>
  )
}
