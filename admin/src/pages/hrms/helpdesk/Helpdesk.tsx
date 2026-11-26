import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import '../../../styles/helpdesk.css'
import { api, ApiError } from '../../../lib/api'
import { canViewTeam, useAuth } from '../../../lib/auth'
import { useQuery } from '../../../lib/useQuery'
import type { EmployeeProfile, User } from '../../../lib/types'
import { dateTime, relativeTime } from '../../../lib/format'
import { Avatar, Empty, EmptyState, ErrorNote, Loading } from '../../../components/ui'
import { IconCheck, IconInfo, IconPlus } from '../../../components/Icons'
import { crm, type Customer } from '../../crm/api'
import { SlaChips, SlaSettings, isBreached, minutesText, useSla } from './sla'
import {
  ColumnSettings, useColumns,
  type ColumnDef,
} from '../../../components/ViewSettings'

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
  /* Incident details: who the call is for. All optional. */
  incident_on?: string | null
  customer_name?: string | null
  contact_name?: string | null
  contact_email?: string | null
  contact_phone?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  pincode?: string | null
  ticket_no?: number | null
  respond_by?: string | null
  resolve_by?: string | null
  first_response_at?: string | null
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

type TicketColumn = ColumnDef & {
  td: (ticket: Ticket, ctx: { select: (id: string | null) => void }) => ReactNode
  className?: string
}

const TICKET_COLUMNS: TicketColumn[] = [
  { key: 'subject', label: 'Subject', locked: true, td: (ticket, ctx) => (
    <button className="hd-rowbtn" onClick={() => ctx.select(ticket.id)}>
      <div className="hd-subject">{ticket.ticket_no ? <code className="hd-no">#INC-{ticket.ticket_no}</code> : null}{ticket.subject}</div>
      <div className="hd-sub">
        {ticket.category_name ?? 'Uncategorised'}
        {' · '}
        <span className={`hd-ptxt hd-ptxt-${ticket.priority}`}>{PRIORITY_P[ticket.priority] ?? ticket.priority}</span>
        {isBreached(ticket) && <span className="hd-breach">SLA breached</span>}
      </div>
    </button>
  ) },
  { key: 'status', label: 'Status', td: (ticket) => <TicketStatusPill value={ticket.status} /> },
  { key: 'raised', label: 'Raised', className: 'hd-when', td: (ticket) => relativeTime(ticket.created_at) },
  { key: 'priority', label: 'Priority', initial: false, td: (ticket) => PRIORITY_LABEL[ticket.priority] ?? ticket.priority },
  { key: 'category', label: 'Category', initial: false, td: (ticket) => ticket.category_name ?? 'Uncategorised' },
  { key: 'assignee', label: 'Handled by', initial: false, td: (ticket) => ticket.assigned_to_name ?? '—' },
  { key: 'resolved', label: 'Resolved', initial: false, className: 'hd-when',
    td: (ticket) => (ticket.resolved_at ? relativeTime(ticket.resolved_at) : '—') },
]

const PRIORITIES_DESC = ['urgent', 'high', 'normal', 'low'] as const

/** P1 is the one that wakes somebody up. The four stored levels read as the P1-P4 an incident desk uses. */
const PRIORITY_P: Record<string, string> = { urgent: 'P1 - Critical', high: 'P2 - High', normal: 'P3 - Normal', low: 'P4 - Low' }

/** The incident's own details in two columns, read-only. Nothing renders for an ordinary ticket with none of them. */
export function IncidentDetails({ ticket }: { ticket: Ticket }) {
  const has = [ticket.customer_name, ticket.contact_name, ticket.contact_email, ticket.contact_phone, ticket.address,
    ticket.city, ticket.state, ticket.pincode, ticket.incident_on].some(Boolean)
  if (!has) return null
  const rows: Array<[string, string | null | undefined]> = [
    ['Incident date', ticket.incident_on ? dateTime(ticket.incident_on) : null],
    ['Priority', PRIORITY_P[ticket.priority] ?? ticket.priority],
    ['Customer', ticket.customer_name],
    ['Engineer', ticket.assigned_to_name],
    ['Contact name', ticket.contact_name],
    ['Contact email', ticket.contact_email],
    ['Contact number', ticket.contact_phone],
    ['Pincode', ticket.pincode],
    ['City', ticket.city],
    ['State', ticket.state],
    ['Address', ticket.address],
    ['Created by', ticket.raised_by_name],
    ['Created date', dateTime(ticket.created_at)],
  ]
  return (
    <div className="hd-incident">
      <h3>Incident details</h3>
      <div className="hd-incident-grid">
        {rows.map(([label, value]) => (
          <div key={label} className={label === 'Address' ? 'is-wide' : undefined}>
            <span>{label}</span>
            <b>{value || '-'}</b>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function Helpdesk() {
  const [params, setParams] = useSearchParams()
  const selected = params.get('t')
  /* A deep link from another module: "dispute this rejection" arrives as
     ?source_module=regularization&source_ref=<uuid>. Both or neither — the
     server rejects a half-filled pair with a 422 naming the field. */
  const sourceModule = params.get('source_module')
  const sourceRef = params.get('source_ref')

  const [dismissed, setDismissed] = useState(false)
  const [slaOpen, setSlaOpen] = useState(false)
  const { user: me } = useAuth()
  const staff = canViewTeam(me) && permits(me, 'can_manage_helpdesk')
  const [raising, setRaising] = useState(sourceModule !== null && sourceRef !== null)
  const [openOnly, setOpenOnly] = useState(false)
  const [status, setStatus] = useState('')
  const columns = useColumns('my-tickets', TICKET_COLUMNS)

  const key = `my-tickets:${status}:${openOnly}`
  const tickets = useQuery<Ticket[]>(key, () => {
    const query = status ? `?status=${status}` : openOnly ? '?open_only=true' : ''
    return api.get<Ticket[]>(`/helpdesk/tickets${query}`)
  })
  const categories = useQuery<Category[]>('hd-categories', () =>
    api.get<Category[]>('/helpdesk/categories'),
  )
  const stats = useQuery<{ avg_first_response_minutes: number | null } | null>('hd-stats', () =>
    api.get<{ avg_first_response_minutes: number | null }>('/helpdesk/stats').catch(() => null),
  )

  const counts = useMemo(() => {
    const all = tickets.data ?? []
    return {
      total: all.length,
      open: all.filter((t) => t.status === 'open' || t.status === 'in_progress').length,
    }
  }, [tickets.data])

  function select(id: string | null) {
    // Closing the panel is a choice: it stays closed until another ticket is picked.
    setDismissed(id === null)
    const next = new URLSearchParams(params)
    if (id) next.set('t', id)
    else next.delete('t')
    /* The source pair is a one-shot prefill for the raise form. Dropping it on
       navigation stops a stale ref riding along into an unrelated ticket. */
    next.delete('source_module')
    next.delete('source_ref')
    setParams(next, { replace: true })
  }

  // Open on the most recent ticket rather than an empty panel. Not while a new incident is being raised from a link,
  // and not once somebody has picked one (or closed the panel on purpose, which clears it only until the next load).
  const latestId = useMemo(() => {
    const all = tickets.data ?? []
    return all.length ? [...all].sort((x, y) => y.created_at.localeCompare(x.created_at))[0].id : null
  }, [tickets.data])
  const shown = selected ?? (raising || dismissed ? null : latestId)

  if (tickets.error) {
    return <ErrorNote>{errorText(tickets.error, 'Could not load your tickets')}</ErrorNote>
  }

  return (
    <div>
      <div className="hd-page-head">
        <i className="hd-page-ic" aria-hidden><IconInfo size={22} /></i>
        <div className="hd-page-title">
          <div className="hd-crumb">Support <span>&rsaquo;</span> <b>Incident desk</b></div>
          <h1>Support &amp; Incident Desk</h1>
          <p>Log customer incidents, track active tickets and follow the replies.</p>
        </div>
        <span className="hd-pill-open">{counts.open} Open</span>
        {stats.data?.avg_first_response_minutes != null && <span className="hd-pill-avg">Avg response: {minutesText(stats.data.avg_first_response_minutes)}</span>}
        {staff && <button className="btn" onClick={() => setSlaOpen(true)}>SLA targets</button>}
        <button className="btn btn-primary" onClick={() => setRaising((v) => !v)}>
          {raising ? 'Hide form' : 'New incident'}
        </button>
      </div>
      {slaOpen && <SlaSettings onClose={() => setSlaOpen(false)} />}

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
        <ColumnSettings defs={TICKET_COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden}
                        onSave={columns.save} onReset={columns.reset} />
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
                    {(columns.visible as TicketColumn[]).map((col) => (
                      <th key={col.key}>{col.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(tickets.data ?? []).map((ticket) => (
                    <tr key={ticket.id} className={ticket.id === shown ? 'hd-row-selected' : undefined}>
                      {(columns.visible as TicketColumn[]).map((col) => (
                        <td key={col.key} className={col.className}>{col.td(ticket, { select })}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card">
          {shown ? (
            <MyTicket
              key={shown}
              ticketId={shown}
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
  const nowLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  const blank = {
    incident_on: nowLocal(), priority: 'normal', category_id: '', problem: '', details: '',
    customer_id: '', customer_name: '', contact_name: '', contact_email: '', contact_phone: '',
    address: '', city: '', state: '', pincode: '',
  }
  const [f, setF] = useState(blank)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [locOpen, setLocOpen] = useState(true)
  const linked = sourceModule !== null && sourceRef !== null
  const customersQ = useQuery<Customer[]>('hd-customers', () => crm.customers({}).catch(() => [] as Customer[]))
  const sla = useSla()
  const [slaForm, setSlaForm] = useState(false)
  const { user: formUser } = useAuth()
  const staffForm = canViewTeam(formUser) && permits(formUser, 'can_manage_helpdesk')
  const nextQ = useQuery<{ next_ticket_no: number } | null>('hd-next-no', () => api.get<{ next_ticket_no: number }>('/helpdesk/tickets/next-number').catch(() => null))
  const set = (patch: Partial<typeof f>) => setF((prev) => ({ ...prev, ...patch }))

  // The contact block starts as the person raising it, read from their own profile. Only fields still empty are filled,
  // so a slow load never overwrites what has already been typed or picked.
  const { user } = useAuth()
  const profileQ = useQuery<EmployeeProfile | null>('hd-my-profile', () => api.get<EmployeeProfile>('/people/me').catch(() => null))
  const mine = useMemo(() => {
    const p = profileQ.data
    return {
      contact_name: p?.full_name ?? user?.full_name ?? '',
      contact_email: p?.email ?? user?.email ?? '',
      contact_phone: user?.phone ?? p?.alternate_phone ?? '',
      address: p?.current_address ?? '',
      city: p?.current_city ?? '',
      state: p?.current_state ?? '',
      pincode: p?.current_postal_code ?? '',
    }
  }, [profileQ.data, user])
  useEffect(() => {
    setF((prev) => {
      const next = { ...prev }
      for (const key of Object.keys(mine) as Array<keyof typeof mine>) if (!prev[key]) next[key] = mine[key] ?? ''
      return next
    })
  }, [mine])

  function resetToProfile() {
    set({ customer_id: '', customer_name: '', ...mine })
  }

  function pickCustomer(id: string) {
    const c = (customersQ.data ?? []).find((x) => x.id === id)
    if (!c) { set({ customer_id: '' }); return }
    set({
      customer_id: id, customer_name: c.company || c.name, contact_name: c.name, contact_email: c.email ?? '',
      contact_phone: c.mobile ?? '', address: c.address ?? '', city: c.city_name ?? '', state: c.state_name ?? '', pincode: c.pincode ?? '',
    })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const problem = f.problem.trim()
      const created = await api.post<Ticket>('/helpdesk/tickets', {
        // The problem summary is the subject; the server also wants a description, which is the extra detail or else the same words.
        subject: problem,
        description: f.details.trim() || problem,
        category_id: f.category_id || null,
        priority: f.priority,
        incident_on: f.incident_on ? new Date(f.incident_on).toISOString() : null,
        customer_name: f.customer_name.trim() || null,
        contact_name: f.contact_name.trim() || null,
        contact_email: f.contact_email.trim() || null,
        contact_phone: f.contact_phone.trim() || null,
        address: f.address.trim() || null,
        city: f.city.trim() || null,
        state: f.state.trim() || null,
        pincode: f.pincode.trim() || null,
        /* Both or neither. The server refuses a ref the raiser cannot already
           see, so a link that does not belong to them fails at write time
           rather than becoming a probe for which ids exist. */
        source_module: linked ? sourceModule : null,
        source_ref: linked ? sourceRef : null,
      })
      onDone(created.id)
    } catch (err) {
      setError(errorText(err, 'Could not raise the incident'))
    } finally {
      setBusy(false)
    }
  }

  const nextId = nextQ.data ? `#INC-${nextQ.data.next_ticket_no}` : '#INC-'
  const catName = categories.find((c) => c.id === f.category_id)?.name
  const place = [f.address, [f.city, f.state].filter(Boolean).join(', ')].filter(Boolean).join(', ')
  const pickedP = PRIORITIES_DESC.find((p) => p === f.priority) ?? 'normal'

  return (
    <form className="hd-create" onSubmit={submit}>
      <header className="hd-create-head">
        <i className="hd-create-ic" aria-hidden><IconPlus size={18} /></i>
        <div>
          <h2>Create incident</h2>
          <p>Contact details start from your profile. Edit any field or pick a customer to log the incident on their behalf.</p>
        </div>
        <span className="hd-nextid">Next ID: {nextId}</span>
      </header>

      <div className="hd-create-grid">
        <div className="hd-create-main">
          {error && <ErrorNote>{error}</ErrorNote>}
          {linked && (
            <div className="hd-source">
              <IconInfo size={14} />
              <span className="hd-source-mod">{sourceModule}</span>
              <span>This incident will be linked back to the item you came from.</span>
            </div>
          )}

          <div className="hd-sec"><span>1. Incident details</span></div>
          <div className="hd-lab-row">Priority{staffForm && <button type="button" className="hd-linkbtn" onClick={() => setSlaForm(true)}>Edit SLA targets</button>}</div>
          {slaForm && <SlaSettings onClose={() => setSlaForm(false)} />}
          <div className="hd-prio-cards" role="radiogroup" aria-label="Priority">
            {PRIORITIES_DESC.map((p) => (
              <button key={p} type="button" role="radio" aria-checked={f.priority === p}
                      className={`hd-pc hd-pc-${p}${f.priority === p ? ' is-on' : ''}`} onClick={() => set({ priority: p })}>
                <i aria-hidden />
                <span className="hd-pc-t"><b>{PRIORITY_P[p]}</b>{sla.byPriority[p] && <small>SLA: {minutesText(sla.byPriority[p]!.respond_minutes)}</small>}</span>
                {f.priority === p && <IconCheck size={14} />}
              </button>
            ))}
          </div>

          <div className="hd-two">
            <label className="hd-f"><span className="hd-lab-row">Reported date &amp; time
              <button type="button" className="hd-linkbtn" onClick={() => set({ incident_on: nowLocal() })}>Set to now</button></span>
              <input type="datetime-local" value={f.incident_on} onChange={(e) => set({ incident_on: e.target.value })} />
            </label>
            <label className="hd-f"><span className="hd-lab">Category</span>
              <select value={f.category_id} onChange={(e) => set({ category_id: e.target.value })}>
                <option value="">Not sure - let triage decide</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          </div>
          <label className="hd-f"><span className="hd-lab-row">Problem summary <b className="lf-req">*</b><em>Required to submit</em></span>
            <input value={f.problem} maxLength={300} required autoFocus onChange={(e) => set({ problem: e.target.value })}
                   placeholder="e.g., Unable to process the monthly payroll batch or login timeout" />
          </label>
          <label className="hd-f"><span className="hd-lab">Additional description / steps to reproduce <small>(optional)</small></span>
            <textarea rows={3} maxLength={20000} value={f.details} onChange={(e) => set({ details: e.target.value })}
                      placeholder="Include error codes, affected employee IDs, or steps leading up to the issue..." />
          </label>

          <div className="hd-sec"><span>2. Customer &amp; point of contact</span>
            <button type="button" className="hd-linkbtn" onClick={resetToProfile}>Reset to my profile</button></div>
          <label className="hd-f"><span className="hd-lab">Select customer account</span>
            <select value={f.customer_id} onChange={(e) => pickCustomer(e.target.value)}>
              <option value="">{(customersQ.data ?? []).length ? 'Myself - no customer' : 'Type the customer below'}</option>
              {(customersQ.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.company || c.name}{c.company ? ` - ${c.name}` : ''}</option>)}
            </select>
          </label>
          <div className="hd-two">
            <label className="hd-f"><span className="hd-lab">Customer name</span>
              <input value={f.customer_name} maxLength={200} onChange={(e) => set({ customer_name: e.target.value })} /></label>
            <label className="hd-f"><span className="hd-lab">Contact name</span>
              <input value={f.contact_name} maxLength={160} onChange={(e) => set({ contact_name: e.target.value })} /></label>
            <label className="hd-f"><span className="hd-lab">Contact number</span>
              <input value={f.contact_phone} maxLength={40} inputMode="tel" onChange={(e) => set({ contact_phone: e.target.value })} /></label>
            <label className="hd-f"><span className="hd-lab">Contact email</span>
              <input type="email" value={f.contact_email} maxLength={200} onChange={(e) => set({ contact_email: e.target.value })} /></label>
          </div>

          <div className="hd-loc">
            <button type="button" className="hd-loc-head" aria-expanded={locOpen} onClick={() => setLocOpen((v) => !v)}>
              <b>3. Service location</b>
              {!locOpen && place && <span>- {place}</span>}
              <i aria-hidden>{locOpen ? '\u25B4' : '\u25BE'}</i>
            </button>
            {locOpen && (
              <div className="hd-loc-body">
                <label className="hd-f"><span className="hd-lab">Address</span>
                  <input value={f.address} maxLength={2000} onChange={(e) => set({ address: e.target.value })} /></label>
                <div className="hd-three">
                  <label className="hd-f"><span className="hd-lab">City</span>
                    <input value={f.city} maxLength={120} onChange={(e) => set({ city: e.target.value })} /></label>
                  <label className="hd-f"><span className="hd-lab">State</span>
                    <input value={f.state} maxLength={120} onChange={(e) => set({ state: e.target.value })} /></label>
                  <label className="hd-f"><span className="hd-lab">Pincode</span>
                    <input value={f.pincode} maxLength={20} inputMode="numeric" onChange={(e) => set({ pincode: e.target.value })} /></label>
                </div>
              </div>
            )}
          </div>

          <div className="hd-create-foot">
            <button type="button" className="hd-linkbtn" onClick={() => setF({ ...blank, incident_on: nowLocal(), ...mine })}>Reset</button>
            <button type="button" className="btn" onClick={onCancel}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !f.problem.trim()}>{busy ? 'Creating...' : 'Create incident'}</button>
          </div>
        </div>

        <aside className="hd-create-side">
          <div className="hd-lab hd-live">Ticket preview <em>Live</em></div>
          <div className="hd-pv">
            <div className="hd-pv-top"><code>{nextId}</code><span className={`hd-pv-p hd-pc-${pickedP}`}><i aria-hidden />{PRIORITY_P[pickedP]}</span></div>
            <div className="hd-pv-sub">Subject</div>
            <div className={`hd-pv-title${f.problem.trim() ? '' : ' is-empty'}`}>{f.problem.trim() || 'Enter a problem summary to preview...'}</div>
            <div className="hd-pv-meta">{catName && <span className="hd-chip">{catName}</span>}<span>{f.incident_on ? dateTime(new Date(f.incident_on).toISOString()) : ''}</span></div>
            {sla.byPriority[pickedP] && (
              <div className="hd-pv-sla">
                <div><b>Target first response</b><span>Resolve within {minutesText(sla.byPriority[pickedP]!.resolve_minutes)}</span></div>
                <code>{minutesText(sla.byPriority[pickedP]!.respond_minutes)}</code>
              </div>
            )}
            <div className="hd-pv-sub">Customer &amp; contact</div>
            <div className="hd-pv-cust">
              <i aria-hidden>{(f.customer_name || f.contact_name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}</i>
              <div>
                <b>{f.customer_name || f.contact_name || '-'}</b>
                <span>{[f.customer_name ? f.contact_name : '', f.contact_phone].filter(Boolean).join(' \u00B7 ')}</span>
                {f.contact_email && <code>{f.contact_email}</code>}
              </div>
            </div>
            {place && <div className="hd-pv-loc">{place}{f.pincode ? ` - ${f.pincode}` : ''}</div>}
          </div>
        </aside>
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
          <h2 className="hd-detail-title">{ticket.ticket_no ? <code className="hd-no">#INC-{ticket.ticket_no}</code> : null}{ticket.subject}</h2>
          <div className="hd-detail-meta">
            <span>{ticket.category_name ?? 'Uncategorised'}</span>
            <span className={`hd-ptxt hd-ptxt-${ticket.priority}`}>{PRIORITY_P[ticket.priority] ?? ticket.priority}</span>
            <span className="hd-when">Raised {relativeTime(ticket.created_at)}</span>
          </div>
        </div>
        <TicketStatusPill value={ticket.status} />
        <button className="btn btn-sm" onClick={onClose}>
          Close panel
        </button>
      </div>

      <SlaChips ticket={ticket} />

      {(ticket.customer_name || ticket.contact_name || ticket.assigned_to_name) && (
        <div className="hd-strip">
          {ticket.customer_name && <b>{ticket.customer_name}</b>}
          {ticket.contact_name && <span>{ticket.contact_name}{ticket.contact_phone ? ` (${ticket.contact_phone})` : ''}</span>}
          {ticket.contact_email && <code>{ticket.contact_email}</code>}
          <em>{ticket.assigned_to_name ? `Handled by ${ticket.assigned_to_name}` : 'Not picked up yet'}</em>
        </div>
      )}

      <SourceBackLink path={`/helpdesk/tickets/${ticket.id}/source`} />

      {ticket.description !== ticket.subject && <p className="hd-body">{ticket.description}</p>}

      <IncidentDetails ticket={ticket} />

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
              <article className={`hd-comment ${comment.author_id === ticket.raised_by ? 'is-customer' : 'is-support'}`} key={comment.id}>
                <Avatar name={comment.author_name ?? 'Former colleague'} small />
                <div className="hd-comment-card">
                  <div className="hd-comment-head">
                    <span className="hd-comment-who">{comment.author_name ?? 'Former colleague'}</span>
                    <span className="hd-comment-badge">{comment.author_id === ticket.raised_by ? 'Customer' : 'Support engineer'}</span>
                    <span className="hd-comment-when">{dateTime(comment.created_at)}</span>
                  </div>
                  <div className="hd-comment-body">{comment.body}</div>
                </div>
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
