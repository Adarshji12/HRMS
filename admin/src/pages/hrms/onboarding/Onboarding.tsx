import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import '../../../styles/onboarding.css'
import { api, ApiError, download, getToken, setToken } from '../../../lib/api'
import { getSlug } from '../../../lib/tenant'
import type { Department } from '../../../lib/types'
import { useQuery } from '../../../lib/useQuery'
import { canAdminister, useAuth } from '../../../lib/auth'
import { dateTime, shortDate } from '../../../lib/format'
import {
  Empty,
  EmptyState,
  ErrorNote,
  Identity,
  Loading,
  Meter,
  StatTile,
} from '../../../components/ui'
import { IconAlert, IconCheck, IconDownload, IconSheet, IconUsers } from '../../../components/Icons'

/* ---------------------------------------------------------------- types ---
   Page-local, as Timesheets.tsx and Assets.tsx do. These mirror
   app/schemas/onboarding.py exactly; lib/types.ts is lead-owned and does not
   carry them. Exported because MyOnboarding.tsx renders the same task and
   document shapes from GET /onboarding/my. */

export interface OnbTask {
  id: string
  instance_id: string
  title: string
  description: string | null
  category: string
  owner_role: string
  sort_order: number
  due_date: string | null
  status: string
  assignee_user_id: string | null
  completed_by: string | null
  completed_at: string | null
  notes: string | null
  requires_document: boolean
  doc_type: string | null
  created_at: string
  assignee_name: string | null
  completed_by_name: string | null
  /** Computed against the org's local today by the service. Never re-derived
   *  here: the browser's midnight is not the company's. */
  is_overdue: boolean
  document_count: number
}

/** One category's tasks. `completed` is DONE only — the group carries no
 *  closed count, unlike the instance, so "done + skipped" is summed from
 *  `tasks` below. See closedIn(). */
export interface OnbTaskGroup {
  category: string
  tasks: OnbTask[]
  total: number
  completed: number
  overdue: number
}

/** `storage_key` is deliberately absent from this shape and from the wire.
 *  Bytes come from GET /onboarding/documents/{id}/file, which re-runs the
 *  permission check on every request. If a page here wants a key, it is
 *  reaching for the wrong endpoint. */
export interface OnbDocument {
  id: string
  instance_id: string
  task_id: string | null
  doc_type: string
  file_name: string
  content_type: string
  file_size: number
  uploaded_by: string | null
  verified_by: string | null
  verified_at: string | null
  verification_note: string | null
  created_at: string
  uploaded_by_name: string | null
  verified_by_name: string | null
  is_verified: boolean
}

export interface OnbInstance {
  id: string
  user_id: string
  template_id: string | null
  template_name: string | null
  joining_date: string
  status: string
  started_at: string | null
  completed_at: string | null
  notes: string | null
  created_at: string
  user_name: string | null
  user_email: string | null
  department_name: string | null
  designation_name: string | null
  manager_name: string | null
  total_tasks: number
  /** DONE only. */
  completed_tasks: number
  /** DONE + SKIPPED. This is the progress denominator's numerator — a
   *  deliberately skipped item must not make a checklist look stuck. */
  closed_tasks: number
  overdue_tasks: number
  documents_pending_verification: number
  /* `progress_pct` exists on the Python model as a plain @property and is NOT
     serialised by Pydantic, so it arrives `undefined`. It is not declared here
     on purpose: a field that is always missing is worse than no field. Use
     progressOf() below. */
}

export interface OnbInstanceDetail extends OnbInstance {
  groups: OnbTaskGroup[]
  documents: OnbDocument[]
}

export interface OnbTemplateTask {
  id: string
  template_id: string
  title: string
  description: string | null
  category: string
  owner_role: string
  /** An offset, never a date: a blueprint cannot know a joining day. */
  due_offset_days: number
  sort_order: number
  requires_document: boolean
  doc_type: string | null
}

export interface OnbTemplate {
  id: string
  name: string
  description: string | null
  department_id: string | null
  is_active: boolean
  created_at: string
  department_name: string | null
  task_count: number
  /** How many hires have ever been started from this template — the reason a
   *  delete gets a confirmation. */
  instance_count: number
}

export interface OnbTemplateDetail extends OnbTemplate {
  tasks: OnbTemplateTask[]
}

/**
 * The roster row this page needs.
 *
 * Declared rather than reusing `lib/types.ts`'s `User`: that interface predates
 * D-016 and has no `status`, and `status` is the only way to render a
 * pre-joiner. **`is_active` is the authentication gate, not `status`** — a
 * pre-joiner is `status === 'pending_setup'` and nothing else, and inferring it
 * from `is_active` would label every suspended employee a new hire.
 */
export interface Person {
  id: string
  full_name: string
  email: string
  is_active: boolean
  status?: string
  joined_on: string | null
  department_id: string | null
  department_name: string | null
  designation_name: string | null
}

/* ------------------------------------------------------------- labels --- */

export const CATEGORY_LABEL: Record<string, string> = {
  documentation: 'Documentation',
  it_setup: 'IT setup',
  training: 'Training',
  compliance: 'Compliance',
  other: 'Other',
}

export const OWNER_ROLE_LABEL: Record<string, string> = {
  hr: 'HR',
  manager: 'Manager',
  it: 'IT',
  employee: 'The new hire',
}

export const TASK_STATUS_LABEL: Record<string, string> = {
  pending: 'Not started',
  in_progress: 'In progress',
  done: 'Done',
  skipped: 'Not applicable',
}

export const INSTANCE_STATUS_LABEL: Record<string, string> = {
  pending_setup: 'Pre-boarding',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

const CATEGORY_ORDER = ['documentation', 'it_setup', 'training', 'compliance', 'other']

/* ------------------------------------------------------------ helpers --- */

/** The sentence the server wrote, never a bare status code. `api.ts` already
 *  unwraps a typed `{reason, message}` detail into `message`. */
export function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  const raw = String(err ?? '')
  return raw || fallback
}

/**
 * The HRMS permission flags restrict, never grant. Absent means "not
 * restricted" — read with `!== false`, never with a bare truthiness check, so a
 * browser holding a page from before a deploy does not hide controls the person
 * is entitled to.
 */
export function permits(user: { [k: string]: unknown } | null, flag: string): boolean {
  if (!user) return false
  return user[flag] !== false
}

/** Done + skipped. A consciously skipped item is settled work, not an open
 *  item, and counting it as open makes a finished checklist look stuck. */
export function closedIn(tasks: OnbTask[]): number {
  return tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length
}

/**
 * Progress for an instance.
 *
 * `OnboardingInstanceOut.progress_pct` is a plain Python property and is not
 * serialised, so it arrives `undefined` — computing it here from the counts is
 * the contract, not a workaround for a slow field.
 */
export function progressOf(i: {
  total_tasks: number
  closed_tasks: number
}): number {
  if (!i.total_tasks) return 0
  return Math.round((i.closed_tasks * 100) / i.total_tasks)
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Multipart POST.
 *
 * `lib/api.ts` is lead-owned and has no multipart door: `api.post` JSON-encodes
 * its body and the private `request()` sets `Content-Type: application/json`,
 * both of which break a file upload. This helper does exactly what `request()`
 * does — tenant header, bearer token, 401 clears the token and full-reloads —
 * and nothing else, so the two cannot drift on the things that matter.
 *
 * **Delete this the moment `api.upload()` exists.** It is reported as an API
 * gap; it is not a second HTTP client.
 */
export async function postMultipart<T>(path: string, form: FormData): Promise<T> {
  const headers = new Headers()
  const slug = getSlug()
  if (slug) headers.set('X-Org-Slug', slug)
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  // Content-Type is left unset on purpose: the browser must add the multipart
  // boundary, and setting it by hand produces a body the server cannot parse.

  const response = await fetch(`/api/v1${path}`, { method: 'POST', headers, body: form })
  if (response.status === 401) {
    setToken(null)
    // Full reload rather than a router push: every cached query in memory is
    // now for a session that no longer exists. Same as api.ts does.
    window.location.href = '/login'
    throw new ApiError(401, 'Session expired')
  }
  if (!response.ok) {
    let message = `Request failed (HTTP ${response.status})`
    let reason: string | undefined
    try {
      const body = await response.json()
      const detail = body?.detail
      if (typeof detail === 'string') message = detail
      else if (Array.isArray(detail)) message = detail.map((d) => d.msg ?? String(d)).join('; ')
      else if (detail && typeof detail.message === 'string') {
        message = detail.message
        reason = detail.reason
      }
    } catch {
      /* Non-JSON error body — keep the status sentence. */
    }
    throw new ApiError(response.status, message, reason)
  }
  return (await response.json()) as T
}

/* ------------------------------------------------------------- pieces --- */

export function InstanceStatusPill({ value }: { value: string }) {
  return (
    <span className={`ob-pill ob-${value}`}>
      <span className="ob-pill-dot" style={{ background: 'currentColor' }} />
      {INSTANCE_STATUS_LABEL[value] ?? value}
    </span>
  )
}

/**
 * The employment-lifecycle badge, read from `users.status` (D-016).
 *
 * Rendered only for `pending_setup` and `inactive`. `is_active` is never
 * consulted: it is the authentication gate, and a suspended active employee is
 * not a pre-joiner.
 */
export function LifecyclePill({ status }: { status: string | undefined }) {
  if (status === 'pending_setup') {
    return <span className="ob-lifecycle" title="Account created, no login yet">Pre-joiner</span>
  }
  if (status === 'inactive') {
    return <span className="ob-lifecycle ob-lifecycle-inactive">Inactive</span>
  }
  return null
}

export function TaskTick({ status }: { status: string }) {
  const cls =
    status === 'done'
      ? 'ob-tick ob-tick-done'
      : status === 'skipped'
        ? 'ob-tick ob-tick-skipped'
        : status === 'in_progress'
          ? 'ob-tick ob-tick-progress'
          : 'ob-tick'
  return (
    <span className={cls} aria-hidden="true">
      {status === 'done' && <IconCheck size={11} />}
    </span>
  )
}

/* ----------------------------------------------------------------- page --- */

export default function Onboarding() {
  const { user } = useAuth()
  const allowed =
    canAdminister(user) && permits(user as unknown as Record<string, unknown> | null, 'can_manage_onboarding')

  const [includeClosed, setIncludeClosed] = useState(false)

  const instances = useQuery<OnbInstance[]>(
    `onboarding-instances-${includeClosed}`,
    () => api.get<OnbInstance[]>(`/onboarding/instances?include_closed=${includeClosed}`),
    { enabled: allowed },
  )
  const templates = useQuery<OnbTemplate[]>(
    'onboarding-templates',
    () => api.get<OnbTemplate[]>('/onboarding/templates'),
    { enabled: allowed },
  )
  const people = useQuery<Person[]>('employees', () => api.get<Person[]>('/admin/employees'), {
    enabled: allowed,
  })

  const [starting, setStarting] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [showTemplates, setShowTemplates] = useState(false)
  const [q, setQ] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  /** Lifecycle status by user id. The pipeline row shows whether the hire can
   *  log in yet, and only the roster knows. */
  const statusById = useMemo(() => {
    const map = new Map<string, string | undefined>()
    for (const p of people.data ?? []) map.set(p.id, p.status)
    return map
  }, [people.data])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (instances.data ?? []).filter((i) => {
      if (statusFilter && i.status !== statusFilter) return false
      if (!needle) return true
      return (
        (i.user_name ?? '').toLowerCase().includes(needle) ||
        (i.user_email ?? '').toLowerCase().includes(needle) ||
        (i.department_name ?? '').toLowerCase().includes(needle) ||
        (i.template_name ?? '').toLowerCase().includes(needle)
      )
    })
  }, [instances.data, q, statusFilter])

  const counts = useMemo(() => {
    const all = instances.data ?? []
    return {
      live: all.filter((i) => i.status === 'pending_setup' || i.status === 'in_progress').length,
      preboarding: all.filter((i) => i.status === 'pending_setup').length,
      overdue: all.reduce((n, i) => n + i.overdue_tasks, 0),
      docs: all.reduce((n, i) => n + i.documents_pending_verification, 0),
    }
  }, [instances.data])

  if (!allowed) {
    return (
      <div>
        <div className="page-head">
          <h1 className="page-title">Onboarding</h1>
        </div>
        <section className="card">
          <EmptyState
            icon={<IconUsers size={22} />}
            title="Onboarding is not open to your account"
            body="A hire's document checklist and their joining date are the same data this permission exists to withhold, so the pipeline is closed to reads as well as writes. Open My onboarding to see your own checklist."
          />
        </section>
      </div>
    )
  }

  if (instances.error) {
    return <ErrorNote>{errorText(instances.error, 'Could not load the onboarding pipeline')}</ErrorNote>
  }

  const filtered = q !== '' || statusFilter !== ''

  function refresh() {
    instances.reload()
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Onboarding</h1>
          <p className="page-sub">
            Every hire's checklist, from offer accepted to the last signature.
          </p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => setShowTemplates((v) => !v)}>
            {showTemplates ? 'Hide templates' : 'Checklist templates'}
          </button>
          <button className="btn btn-primary" onClick={() => setStarting((v) => !v)}>
            {starting ? 'Cancel' : 'Start onboarding'}
          </button>
        </div>
      </div>

      {(instances.data ?? []).length > 0 && (
        <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
          <StatTile label="Checklists live" value={String(counts.live)} accent="var(--brand)" />
          <StatTile
            label="Pre-boarding"
            value={String(counts.preboarding)}
            meta={counts.preboarding ? 'not started yet' : undefined}
          />
          <StatTile
            label="Overdue tasks"
            value={String(counts.overdue)}
            meta={counts.overdue ? 'across all hires' : undefined}
            accent={counts.overdue ? 'var(--status-critical)' : undefined}
          />
          <StatTile
            label="Documents to verify"
            value={String(counts.docs)}
            meta={counts.docs ? 'awaiting HR sign-off' : undefined}
            accent={counts.docs ? 'var(--status-warn)' : undefined}
          />
        </div>
      )}

      {starting && (
        <StartForm
          people={people.data ?? []}
          templates={(templates.data ?? []).filter((t) => t.is_active)}
          onCancel={() => setStarting(false)}
          onDone={(created) => {
            setStarting(false)
            setOpenId(created.id)
            refresh()
          }}
        />
      )}

      {showTemplates && (
        <TemplatesPanel
          templates={templates.data ?? []}
          loading={templates.loading}
          error={templates.error}
          onChanged={() => templates.reload()}
        />
      )}

      <div className="filter-row">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search hire, email, department…"
          aria-label="Search the pipeline"
          style={{ minWidth: 220 }}
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Checklist status"
        >
          <option value="">Any status</option>
          {Object.entries(INSTANCE_STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <label className="ob-muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={includeClosed}
            onChange={(e) => setIncludeClosed(e.target.checked)}
          />
          Include completed and cancelled
        </label>
        <span className="filter-count">
          {rows.length} of {(instances.data ?? []).length}
        </span>
        {filtered && (
          <button
            className="filter-reset"
            onClick={() => {
              setQ('')
              setStatusFilter('')
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      <section className="card" style={{ opacity: instances.refetching ? 0.6 : 1 }}>
        {rows.length === 0 ? (
          instances.loading ? (
            <Loading />
          ) : filtered ? (
            <EmptyState
              icon={<IconUsers size={22} />}
              title="No checklist matches"
              body="Clear the filters, or tick “include completed and cancelled” — a hire who finished onboarding last month is not in this list by default."
            />
          ) : (
            <EmptyState
              icon={<IconUsers size={22} />}
              title="Nobody is being onboarded"
              body="Start a checklist for a hire and every step — documents, IT setup, training, compliance — is tracked in one place, with the pre-joiners who have no login yet shown alongside the people already at their desks."
              action={
                <button className="btn btn-primary" onClick={() => setStarting(true)}>
                  Start the first checklist
                </button>
              }
            />
          )
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Hire</th>
                  <th>Status</th>
                  <th>Joining</th>
                  <th>Template</th>
                  <th>Progress</th>
                  <th>Flags</th>
                  <th style={{ textAlign: 'right' }}>Checklist</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const pct = progressOf(row)
                  const skipped = row.closed_tasks - row.completed_tasks
                  return (
                    <tr
                      key={row.id}
                      className={`ob-row-click${openId === row.id ? ' ob-row-open' : ''}`}
                      onClick={() => setOpenId(openId === row.id ? null : row.id)}
                    >
                      <td>
                        <Identity
                          name={row.user_name ?? 'Unknown'}
                          small
                          meta={
                            <>
                              {row.user_email}
                              {row.department_name ? ` · ${row.department_name}` : ''}
                            </>
                          }
                        />
                        <div style={{ marginTop: 4 }}>
                          <LifecyclePill status={statusById.get(row.user_id)} />
                        </div>
                      </td>
                      <td>
                        <InstanceStatusPill value={row.status} />
                      </td>
                      <td className="ob-when">{shortDate(row.joining_date)}</td>
                      <td className="ob-muted">
                        {row.template_name ?? <em>ad hoc</em>}
                      </td>
                      <td>
                        <div className="ob-progress">
                          <Meter value={row.closed_tasks} max={row.total_tasks} />
                          <span className="ob-progress-pct">{pct}%</span>
                        </div>
                        <div className="ob-progress-caption">
                          {row.total_tasks === 0
                            ? 'no tasks yet'
                            : `${row.completed_tasks} done${skipped > 0 ? `, ${skipped} n/a` : ''} of ${row.total_tasks}`}
                        </div>
                      </td>
                      <td>
                        {row.overdue_tasks > 0 && (
                          <div className="ob-flag">
                            <IconAlert size={12} /> {row.overdue_tasks} overdue
                          </div>
                        )}
                        {row.documents_pending_verification > 0 && (
                          <div className="ob-muted">
                            {row.documents_pending_verification} doc
                            {row.documents_pending_verification === 1 ? '' : 's'} to verify
                          </div>
                        )}
                        {row.overdue_tasks === 0 && row.documents_pending_verification === 0 && (
                          <span className="ob-muted">—</span>
                        )}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="ob-actions">
                          <button
                            className="btn btn-sm"
                            onClick={() => setOpenId(openId === row.id ? null : row.id)}
                          >
                            {openId === row.id ? 'Close' : 'Open'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {openId && (
        <InstanceDetail
          key={openId}
          instanceId={openId}
          people={people.data ?? []}
          lifecycle={statusById.get(
            (instances.data ?? []).find((i) => i.id === openId)?.user_id ?? '',
          )}
          onClose={() => setOpenId(null)}
          onChanged={refresh}
        />
      )}
    </div>
  )
}

/* ---------------------------------------------------------- start form --- */

/**
 * Start a checklist for a hire.
 *
 * Unguarded on the date on purpose: this is the door that exists so HR can
 * start onboarding for somebody imported last week. The conditional door — the
 * one user creation calls, which declines historical joining dates — is a
 * service function and is not exposed to this console at all.
 */
function StartForm({
  people,
  templates,
  onCancel,
  onDone,
}: {
  people: Person[]
  templates: OnbTemplate[]
  onCancel: () => void
  onDone: (created: OnbInstanceDetail) => void
}) {
  const [userId, setUserId] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [joiningDate, setJoiningDate] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const chosen = people.find((p) => p.id === userId)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const created = await api.post<OnbInstanceDetail>('/onboarding/instances', {
        user_id: userId,
        template_id: templateId || null,
        joining_date: joiningDate || null,
        notes: notes.trim() || null,
      })
      onDone(created)
    } catch (err) {
      setError(errorText(err, 'Could not start the checklist'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ob-panel" onSubmit={submit}>
      <div className="ob-panel-head">
        <div>
          <h2 className="ob-panel-title">Start onboarding</h2>
          <p className="ob-panel-sub">
            The template's tasks are <b>copied</b> onto this hire. From then on the checklist is
            theirs: editing the template later will not touch it, and neither will deleting it.
          </p>
        </div>
      </div>

      {error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="settings-grid">
        <label className="setting">
          Hire
          <select value={userId} onChange={(e) => setUserId(e.target.value)} required autoFocus>
            <option value="">Choose an employee…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name}
                {p.status === 'pending_setup' ? ' — pre-joiner' : ''}
                {p.status === 'inactive' ? ' — inactive' : ''}
              </option>
            ))}
          </select>
          <span className="setting-hint">
            {chosen?.status === 'pending_setup'
              ? 'A pre-joiner: the account exists but cannot log in yet. Their checklist runs regardless — pre-boarding tasks are the point.'
              : 'Anyone on the roster. A hire does not need to be able to log in for their checklist to exist.'}
          </span>
        </label>

        <label className="setting">
          Template
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">
              {templates.length ? 'Match the hire’s department' : 'No templates — ad-hoc checklist'}
            </option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.task_count} task{t.task_count === 1 ? '' : 's'})
              </option>
            ))}
          </select>
          <span className="setting-hint">
            Left empty, the server picks the template matching the hire's department, or starts an
            empty checklist you add tasks to by hand.
          </span>
        </label>

        <label className="setting">
          Joining date
          <input
            type="date"
            value={joiningDate}
            onChange={(e) => setJoiningDate(e.target.value)}
          />
          <span className="setting-hint">
            Empty defaults to the employee's recorded joining day. Every task's due date is
            resolved from this once, at the moment the checklist is created.
          </span>
        </label>

        <label className="setting" style={{ gridColumn: '1 / -1' }}>
          Notes
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Anything the people working this checklist need to know."
          />
        </label>
      </div>

      <div className="btn-group" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy || !userId}>
          {busy ? 'Starting…' : 'Start the checklist'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/* --------------------------------------------------------- the checklist --- */

function InstanceDetail({
  instanceId,
  people,
  lifecycle,
  onClose,
  onChanged,
}: {
  instanceId: string
  people: Person[]
  lifecycle: string | undefined
  onClose: () => void
  onChanged: () => void
}) {
  const detail = useQuery<OnbInstanceDetail>(`onboarding-instance-${instanceId}`, () =>
    api.get<OnbInstanceDetail>(`/onboarding/instances/${instanceId}`),
  )
  const [panelError, setPanelError] = useState<string | null>(null)
  const [addingTo, setAddingTo] = useState<string | null>(null)
  const [editingHeader, setEditingHeader] = useState(false)

  function reload() {
    setPanelError(null)
    detail.reload()
    onChanged()
  }

  if (detail.loading) {
    return (
      <section className="card" style={{ marginTop: 16 }}>
        <Loading label="Opening the checklist…" />
      </section>
    )
  }
  if (detail.error || !detail.data) {
    return (
      <section className="card" style={{ marginTop: 16 }}>
        <ErrorNote>{errorText(detail.error, 'Could not open this checklist')}</ErrorNote>
      </section>
    )
  }

  const d = detail.data
  const pct = progressOf(d)
  const skipped = d.closed_tasks - d.completed_tasks
  const closed = d.status === 'completed' || d.status === 'cancelled'

  return (
    <section className="card" style={{ marginTop: 16, opacity: detail.refetching ? 0.7 : 1 }}>
      <div className="card-head">
        <div>
          <h2 className="card-title">{d.user_name ?? 'Checklist'}</h2>
          <div className="ob-muted" style={{ marginTop: 3 }}>
            Joining {shortDate(d.joining_date)}
            {d.designation_name ? ` · ${d.designation_name}` : ''}
            {d.manager_name ? ` · reports to ${d.manager_name}` : ''}
            {d.template_name ? ` · from “${d.template_name}”` : ' · ad-hoc checklist'}
          </div>
          <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
            <InstanceStatusPill value={d.status} />
            <LifecyclePill status={lifecycle} />
          </div>
        </div>
        <div className="card-tools">
          <button className="btn btn-sm" onClick={() => setEditingHeader((v) => !v)}>
            {editingHeader ? 'Cancel' : 'Edit'}
          </button>
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      <div className="ob-progress" style={{ marginBottom: 6 }}>
        <Meter value={d.closed_tasks} max={d.total_tasks} />
        <span className="ob-progress-pct">{pct}%</span>
      </div>
      <div className="ob-progress-caption" style={{ marginBottom: 14 }}>
        {d.total_tasks === 0
          ? 'This checklist has no tasks yet.'
          : `${d.completed_tasks} done${skipped > 0 ? `, ${skipped} not applicable` : ''} of ${d.total_tasks}. Skipped items count as settled — a step that genuinely does not apply should not hold the bar back.`}
      </div>

      {lifecycle === 'pending_setup' && (
        <div className="ob-note" style={{ marginBottom: 14 }}>
          <b>Pre-joiner.</b> This account exists but cannot sign in yet, so anything owned by
          “the new hire” has to wait or be done on their behalf. Pre-boarding tasks — the offer
          letter, the background check, the desk — are exactly the ones that run now.
        </div>
      )}

      {d.notes && (
        <div className="ob-task-note" style={{ marginBottom: 14 }}>
          <span className="ob-task-note-label">Notes</span>
          {d.notes}
        </div>
      )}

      {editingHeader && (
        <InstanceHeaderForm
          instance={d}
          onCancel={() => setEditingHeader(false)}
          onDone={() => {
            setEditingHeader(false)
            reload()
          }}
        />
      )}

      {panelError && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{panelError}</ErrorNote>
        </div>
      )}

      {d.groups.length === 0 ? (
        <EmptyState
          icon={<IconSheet size={22} />}
          title="This checklist is empty"
          body="It was started without a template, or the template it came from had no tasks. Add the steps this hire actually needs — they belong to this checklist alone."
          action={
            !closed && (
              <button className="btn btn-primary" onClick={() => setAddingTo('documentation')}>
                Add the first task
              </button>
            )
          }
        />
      ) : (
        <div className="ob-groups">
          {d.groups.map((group) => (
            <TaskGroup
              key={group.category}
              group={group}
              instance={d}
              people={people}
              readOnly={closed}
              adding={addingTo === group.category}
              onAdd={() => setAddingTo(addingTo === group.category ? null : group.category)}
              onError={setPanelError}
              onChanged={reload}
            />
          ))}
        </div>
      )}

      {!closed && d.groups.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <AddTaskLauncher
            categories={CATEGORY_ORDER.filter((c) => !d.groups.some((g) => g.category === c))}
            active={addingTo}
            onPick={(c) => setAddingTo(addingTo === c ? null : c)}
          />
        </div>
      )}

      {addingTo && !d.groups.some((g) => g.category === addingTo) && (
        <TaskForm
          instanceId={d.id}
          category={addingTo}
          people={people}
          task={null}
          onCancel={() => setAddingTo(null)}
          onDone={() => {
            setAddingTo(null)
            reload()
          }}
        />
      )}

      <DocumentsPanel
        instance={d}
        onError={setPanelError}
        onChanged={reload}
      />
    </section>
  )
}

function AddTaskLauncher({
  categories,
  active,
  onPick,
}: {
  categories: string[]
  active: string | null
  onPick: (c: string) => void
}) {
  if (categories.length === 0) return null
  return (
    <div className="btn-group" style={{ flexWrap: 'wrap' }}>
      <span className="ob-muted">Add a task under</span>
      {categories.map((c) => (
        <button
          key={c}
          className={`btn btn-sm${active === c ? ' btn-primary' : ''}`}
          onClick={() => onPick(c)}
        >
          {CATEGORY_LABEL[c] ?? c}
        </button>
      ))}
    </div>
  )
}

/**
 * Editing the instance header.
 *
 * Moving the joining date reschedules every *open* task by the same delta;
 * completed tasks keep their dates because they record what actually happened.
 * Said here rather than discovered afterwards.
 */
function InstanceHeaderForm({
  instance,
  onCancel,
  onDone,
}: {
  instance: OnbInstanceDetail
  onCancel: () => void
  onDone: () => void
}) {
  const [status, setStatus] = useState(instance.status)
  const [joiningDate, setJoiningDate] = useState(instance.joining_date)
  const [notes, setNotes] = useState(instance.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const dateMoved = joiningDate !== instance.joining_date
  const openTasks = instance.groups
    .flatMap((g) => g.tasks)
    .filter((t) => t.status !== 'done' && t.status !== 'skipped').length

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.patch(`/onboarding/instances/${instance.id}`, {
        status,
        joining_date: joiningDate,
        notes: notes.trim() || null,
      })
      onDone()
    } catch (err) {
      setError(errorText(err, 'Could not save the checklist'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ob-panel" onSubmit={submit}>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <div className="settings-grid">
        <label className="setting">
          Checklist status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {Object.entries(INSTANCE_STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="setting">
          Joining date
          <input
            type="date"
            value={joiningDate}
            onChange={(e) => setJoiningDate(e.target.value)}
            required
          />
        </label>
        <label className="setting" style={{ gridColumn: '1 / -1' }}>
          Notes
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </label>
      </div>

      {dateMoved && (
        <div className="ob-note ob-note-warn" style={{ marginTop: 12 }}>
          <b>Moving the joining date moves the checklist.</b> All {openTasks} open task
          {openTasks === 1 ? '' : 's'} shift by the same number of days. Tasks already done or
          marked not applicable keep their dates — they record what actually happened.
        </div>
      )}

      <div className="btn-group" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/* --------------------------------------------------------------- group --- */

function TaskGroup({
  group,
  instance,
  people,
  readOnly,
  adding,
  onAdd,
  onError,
  onChanged,
}: {
  group: OnbTaskGroup
  instance: OnbInstanceDetail
  people: Person[]
  readOnly: boolean
  adding: boolean
  onAdd: () => void
  onError: (msg: string | null) => void
  onChanged: () => void
}) {
  const [editing, setEditing] = useState<OnbTask | null>(null)
  const closed = closedIn(group.tasks)
  const skipped = closed - group.completed

  return (
    <div className="ob-group">
      <div className="ob-group-head">
        <div>
          <div className="ob-group-name">{CATEGORY_LABEL[group.category] ?? group.category}</div>
          {group.category === 'it_setup' && (
            <div className="ob-muted" style={{ marginTop: 2 }}>
              Where the asset register hooks in — a laptop issued against one of these steps shows
              up in Assets.
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className="ob-group-counts">
            {closed} of {group.total} settled
            {skipped > 0 ? ` · ${skipped} n/a` : ''}
            {group.overdue > 0 ? ` · ${group.overdue} overdue` : ''}
          </span>
          {!readOnly && (
            <button className="btn btn-sm" onClick={onAdd}>
              {adding ? 'Cancel' : 'Add task'}
            </button>
          )}
        </div>
      </div>

      {group.tasks.length === 0 ? (
        <Empty>No tasks in this section.</Empty>
      ) : (
        group.tasks.map((task) =>
          editing?.id === task.id ? (
            <div key={task.id} style={{ padding: '0 14px 12px' }}>
              <TaskForm
                instanceId={instance.id}
                category={task.category}
                people={people}
                task={task}
                onCancel={() => setEditing(null)}
                onDone={() => {
                  setEditing(null)
                  onChanged()
                }}
              />
            </div>
          ) : (
            <TaskRow
              key={task.id}
              task={task}
              readOnly={readOnly}
              onEdit={() => setEditing(task)}
              onError={onError}
              onChanged={onChanged}
            />
          ),
        )
      )}

      {adding && (
        <div style={{ padding: '0 14px 12px' }}>
          <TaskForm
            instanceId={instance.id}
            category={group.category}
            people={people}
            task={null}
            onCancel={onAdd}
            onDone={() => {
              onAdd()
              onChanged()
            }}
          />
        </div>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- task --- */

/**
 * One checklist row.
 *
 * Exported because the hire's own page renders the identical row — the same
 * task, the same evidence, the same status control — and a second copy of it
 * would be the place the two views quietly start disagreeing. `readOnly` and
 * `canAct` are separate: HR can act on everything, the hire only on their own
 * items, and a row nobody may act on is still worth seeing.
 */
export function TaskRow({
  task,
  readOnly,
  canAct = true,
  waitingLabel,
  extra,
  onEdit,
  onError,
  onChanged,
}: {
  task: OnbTask
  readOnly: boolean
  canAct?: boolean
  waitingLabel?: string
  extra?: ReactNode
  onEdit?: () => void
  onError: (msg: string | null) => void
  onChanged: () => void
}) {
  const [skipping, setSkipping] = useState(false)
  const [skipNote, setSkipNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function setStatus(next: string, notes?: string) {
    setBusy(true)
    onError(null)
    try {
      await api.post(`/onboarding/tasks/${task.id}/status`, { status: next, notes: notes ?? null })
      setSkipping(false)
      setSkipNote('')
      onChanged()
    } catch (err) {
      onError(errorText(err, 'Could not update this task'))
    } finally {
      setBusy(false)
    }
  }

  const rowClass =
    task.status === 'done'
      ? 'ob-task ob-task-done'
      : task.status === 'skipped'
        ? 'ob-task ob-task-skipped'
        : 'ob-task'

  return (
    <div className={rowClass}>
      <TaskTick status={task.status} />

      <div className="ob-task-body">
        <div className={`ob-task-title${task.status === 'done' ? ' ob-task-title-done' : ''}`}>
          {task.title}
        </div>
        {task.description && <div className="ob-task-desc">{task.description}</div>}

        <div className="ob-task-meta">
          <span>
            Owner <b>{OWNER_ROLE_LABEL[task.owner_role] ?? task.owner_role}</b>
          </span>
          {task.assignee_name && (
            <span>
              Assigned to <b>{task.assignee_name}</b>
            </span>
          )}
          {task.due_date && (
            <span className={task.is_overdue ? 'ob-overdue' : undefined}>
              Due {shortDate(task.due_date)}
              {task.is_overdue ? ' · overdue' : ''}
            </span>
          )}
          {task.requires_document && (
            <span className={`ob-tag ob-tag-doc`}>
              {task.doc_type ? `${task.doc_type} required` : 'Document required'}
              {task.document_count > 0 ? ` · ${task.document_count} uploaded` : ''}
            </span>
          )}
          {task.completed_at && (
            <span>
              {task.status === 'skipped' ? 'Skipped' : 'Completed'} {dateTime(task.completed_at)}
              {task.completed_by_name ? ` by ${task.completed_by_name}` : ''}
            </span>
          )}
        </div>

        {task.notes && (
          <div className="ob-task-note">
            <span className="ob-task-note-label">
              {task.status === 'skipped' ? 'Why this was skipped' : 'Note'}
            </span>
            {task.notes}
          </div>
        )}

        {skipping && (
          <div className="ob-inline-form">
            <textarea
              value={skipNote}
              onChange={(e) => setSkipNote(e.target.value)}
              placeholder="Why does this step not apply? A skip with no reason is worthless to whoever audits this later."
              autoFocus
            />
            <div className="btn-group">
              <button
                className="btn btn-sm btn-primary"
                disabled={busy || !skipNote.trim()}
                onClick={() => void setStatus('skipped', skipNote.trim())}
              >
                {busy ? 'Saving…' : 'Mark not applicable'}
              </button>
              <button className="btn btn-sm" onClick={() => setSkipping(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {extra}
      </div>

      <div className="ob-task-side">
        {readOnly || !canAct ? (
          <>
            <span className="ob-tag">{TASK_STATUS_LABEL[task.status] ?? task.status}</span>
            {!readOnly && waitingLabel && <span className="ob-waiting">{waitingLabel}</span>}
          </>
        ) : (
          <div className="ob-task-controls">
            <select
              value={task.status}
              disabled={busy}
              aria-label={`Status of ${task.title}`}
              onChange={(e) => {
                const next = e.target.value
                if (next === task.status) return
                if (next === 'skipped') {
                  /* The server refuses a skip with no reason, so the reason is
                     part of the action rather than a follow-up nobody makes. */
                  setSkipping(true)
                  return
                }
                void setStatus(next)
              }}
            >
              {Object.entries(TASK_STATUS_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {onEdit && (
              <button className="btn btn-sm" onClick={onEdit}>
                Edit
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Create or rewrite one live task. Carries a concrete date, never an offset —
 *  by the time a task exists on an instance the joining date has been applied,
 *  and sending an offset here would silently re-resolve dates the checklist has
 *  been operating on. */
function TaskForm({
  instanceId,
  category,
  people,
  task,
  onCancel,
  onDone,
}: {
  instanceId: string
  category: string
  people: Person[]
  task: OnbTask | null
  onCancel: () => void
  onDone: () => void
}) {
  const [form, setForm] = useState({
    title: task?.title ?? '',
    description: task?.description ?? '',
    category: task?.category ?? category,
    owner_role: task?.owner_role ?? 'hr',
    due_date: task?.due_date ?? '',
    sort_order: task?.sort_order ?? 0,
    assignee_user_id: task?.assignee_user_id ?? '',
    requires_document: task?.requires_document ?? false,
    doc_type: task?.doc_type ?? '',
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const body = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      category: form.category,
      owner_role: form.owner_role,
      due_date: form.due_date || null,
      sort_order: form.sort_order,
      assignee_user_id: form.assignee_user_id || null,
      requires_document: form.requires_document,
      doc_type: form.requires_document ? form.doc_type.trim() || null : null,
    }
    try {
      if (task) await api.put(`/onboarding/tasks/${task.id}`, body)
      else await api.post(`/onboarding/instances/${instanceId}/tasks`, body)
      onDone()
    } catch (err) {
      setError(errorText(err, 'Could not save the task'))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!task) return
    setBusy(true)
    setError(null)
    try {
      await api.del(`/onboarding/tasks/${task.id}`)
      onDone()
    } catch (err) {
      setError(errorText(err, 'Could not delete the task'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ob-panel" style={{ marginBottom: 0 }} onSubmit={submit}>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <div className="settings-grid">
        <label className="setting" style={{ gridColumn: '1 / -1' }}>
          Task
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="Collect signed offer letter"
            required
            autoFocus
          />
        </label>
        <label className="setting">
          Section
          <select
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          >
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="setting">
          Owner
          <select
            value={form.owner_role}
            onChange={(e) => setForm({ ...form, owner_role: e.target.value })}
          >
            {Object.entries(OWNER_ROLE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <span className="setting-hint">
            Only tasks owned by “the new hire” can be ticked off by them.
          </span>
        </label>
        <label className="setting">
          Assign to
          <select
            value={form.assignee_user_id}
            onChange={(e) => setForm({ ...form, assignee_user_id: e.target.value })}
          >
            <option value="">Nobody in particular</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name}
              </option>
            ))}
          </select>
          <span className="setting-hint">A named assignee may complete this task themselves.</span>
        </label>
        <label className="setting">
          Due date
          <input
            type="date"
            value={form.due_date}
            onChange={(e) => setForm({ ...form, due_date: e.target.value })}
          />
        </label>
        <label className="setting">
          Order
          <input
            type="number"
            min={0}
            max={10000}
            value={form.sort_order}
            onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })}
          />
        </label>
        <label className="setting" style={{ gridColumn: '1 / -1' }}>
          Description
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            rows={2}
          />
        </label>
        <label className="setting">
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={form.requires_document}
              onChange={(e) => setForm({ ...form, requires_document: e.target.checked })}
            />
            Needs a document
          </span>
          <span className="setting-hint">
            The server refuses to mark this done until a file has been uploaded against it.
          </span>
        </label>
        {form.requires_document && (
          <label className="setting">
            Document type
            <input
              value={form.doc_type}
              onChange={(e) => setForm({ ...form, doc_type: e.target.value })}
              placeholder="pan_card"
            />
          </label>
        )}
      </div>

      <div className="btn-group" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : task ? 'Save task' : 'Add task'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        {task && (
          <button type="button" className="btn" disabled={busy} onClick={() => void remove()}>
            Delete
          </button>
        )}
      </div>
    </form>
  )
}

/* ----------------------------------------------------------- documents --- */

/**
 * The hire's file evidence.
 *
 * Downloads go through `GET /onboarding/documents/{id}/file`, which re-runs the
 * permission check on every request. There is no storage key in any of these
 * responses and there should never be one: a key is a capability the holder can
 * replay, and whose neighbours it can enumerate.
 */
function DocumentsPanel({
  instance,
  onError,
  onChanged,
}: {
  instance: OnbInstanceDetail
  onError: (msg: string | null) => void
  onChanged: () => void
}) {
  const [uploading, setUploading] = useState(false)
  const pendingTasks = instance.groups
    .flatMap((g) => g.tasks)
    .filter((t) => t.requires_document)

  return (
    <div style={{ marginTop: 18 }}>
      <div className="ob-panel-head">
        <div>
          <h3 className="ob-panel-title">Documents</h3>
          <p className="ob-panel-sub">
            The hire supplies these; somebody other than the hire says they are genuine, or the
            verification asserts nothing.
          </p>
        </div>
        <button className="btn btn-sm" onClick={() => setUploading((v) => !v)}>
          {uploading ? 'Cancel' : 'Upload a document'}
        </button>
      </div>

      {uploading && (
        <UploadForm
          instanceId={instance.id}
          tasks={pendingTasks}
          onCancel={() => setUploading(false)}
          onDone={() => {
            setUploading(false)
            onChanged()
          }}
        />
      )}

      {instance.documents.length === 0 ? (
        <Empty>
          Nothing uploaded yet. Tasks marked “needs a document” cannot be completed until a file
          is attached to them.
        </Empty>
      ) : (
        <div className="ob-docs">
          {instance.documents.map((doc) => (
            <DocumentRow key={doc.id} doc={doc} onError={onError} onChanged={onChanged} />
          ))}
        </div>
      )}
    </div>
  )
}

function DocumentRow({
  doc,
  onError,
  onChanged,
}: {
  doc: OnbDocument
  onError: (msg: string | null) => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [note, setNote] = useState('')

  async function get() {
    setBusy(true)
    onError(null)
    try {
      await download(`/onboarding/documents/${doc.id}/file`, doc.file_name || 'document')
    } catch (err) {
      onError(errorText(err, 'Could not download that document'))
    } finally {
      setBusy(false)
    }
  }

  async function verify(verified: boolean) {
    setBusy(true)
    onError(null)
    try {
      await api.post(`/onboarding/documents/${doc.id}/verify`, {
        verified,
        verification_note: note.trim() || null,
      })
      setVerifying(false)
      setNote('')
      onChanged()
    } catch (err) {
      onError(errorText(err, 'Could not record the verification'))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    onError(null)
    try {
      await api.del(`/onboarding/documents/${doc.id}`)
      onChanged()
    } catch (err) {
      onError(errorText(err, 'Could not delete that document'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ob-doc">
      <div className="ob-doc-body">
        <div className="ob-doc-name">{doc.file_name}</div>
        <div className="ob-doc-meta">
          {doc.doc_type} · {fileSize(doc.file_size)} ·{' '}
          {doc.uploaded_by_name ? `uploaded by ${doc.uploaded_by_name}` : 'uploaded'}{' '}
          {dateTime(doc.created_at)}
          {doc.is_verified && doc.verified_by_name ? ` · verified by ${doc.verified_by_name}` : ''}
        </div>
        {doc.verification_note && (
          <div className="ob-task-note">
            <span className="ob-task-note-label">Verification note</span>
            {doc.verification_note}
          </div>
        )}
        {verifying && (
          <div className="ob-inline-form">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional — what you checked, or why this is being rejected."
              autoFocus
            />
            <div className="btn-group">
              <button
                className="btn btn-sm btn-primary"
                disabled={busy}
                onClick={() => void verify(true)}
              >
                Mark verified
              </button>
              <button className="btn btn-sm" disabled={busy} onClick={() => void verify(false)}>
                Mark not verified
              </button>
              <button className="btn btn-sm" onClick={() => setVerifying(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <span className={`ob-pill ${doc.is_verified ? 'ob-verified' : 'ob-unverified'}`}>
        <span className="ob-pill-dot" style={{ background: 'currentColor' }} />
        {doc.is_verified ? 'Verified' : 'Not verified'}
      </span>

      <div className="ob-doc-actions">
        <button className="btn btn-sm" disabled={busy} onClick={() => void get()}>
          <IconDownload size={13} /> Download
        </button>
        <button className="btn btn-sm" onClick={() => setVerifying((v) => !v)}>
          {doc.is_verified ? 'Re-check' : 'Verify'}
        </button>
        <button className="btn btn-sm" disabled={busy} onClick={() => void remove()}>
          Delete
        </button>
      </div>
    </div>
  )
}

/** Multipart upload: JSON metadata in `meta`, the file in `file`. Exported so
 *  the hire's own page uses the identical request. */
export function UploadForm({
  instanceId,
  tasks,
  defaultTaskId,
  onCancel,
  onDone,
}: {
  instanceId: string
  tasks: OnbTask[]
  /** Preselects the task this upload answers. Opened from a specific row — the
   *  hire's own "upload your PAN card" button — the answer is already known,
   *  and leaving it unattached would upload a file that satisfies nothing. */
  defaultTaskId?: string
  onCancel: () => void
  onDone: () => void
}) {
  const preselected = defaultTaskId ? tasks.find((t) => t.id === defaultTaskId) : undefined
  const [taskId, setTaskId] = useState(preselected?.id ?? '')
  const [docType, setDocType] = useState(preselected?.doc_type ?? '')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function pickTask(id: string) {
    setTaskId(id)
    const t = tasks.find((x) => x.id === id)
    if (t?.doc_type) setDocType(t.doc_type)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!file) return
    setBusy(true)
    setError(null)
    const form = new FormData()
    form.append(
      'meta',
      JSON.stringify({ doc_type: docType.trim(), task_id: taskId || null }),
    )
    form.append('file', file)
    try {
      await postMultipart<OnbDocument>(`/onboarding/instances/${instanceId}/documents`, form)
      onDone()
    } catch (err) {
      setError(errorText(err, 'Could not upload that file'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ob-upload" onSubmit={submit}>
      {error && <ErrorNote>{error}</ErrorNote>}
      {preselected ? (
        <div className="ob-muted">
          Attached to <b>{preselected.title}</b>
        </div>
      ) : (
        <label className="setting">
          Against which task
          <select value={taskId} onChange={(e) => pickTask(e.target.value)}>
            <option value="">Not tied to a task</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
                {t.doc_type ? ` (${t.doc_type})` : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="setting">
        Document type
        <input
          value={docType}
          onChange={(e) => setDocType(e.target.value)}
          placeholder="pan_card"
          required
        />
      </label>
      <div className="ob-upload-row">
        <input
          type="file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          required
          aria-label="File to upload"
        />
      </div>
      <div className="btn-group">
        <button className="btn btn-sm btn-primary" disabled={busy || !file || !docType.trim()}>
          {busy ? 'Uploading…' : 'Upload'}
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/* ----------------------------------------------------------- templates --- */

/**
 * The blueprints.
 *
 * A template is not a live checklist and the panel says so where the editing
 * happens: instantiation is a **copy**, so nothing here reaches an in-flight
 * hire. That is the whole template-versus-instance rule, and presenting a
 * template edit as if it propagated would be the single most damaging lie this
 * page could tell an HR admin.
 */
function TemplatesPanel({
  templates,
  loading,
  error,
  onChanged,
}: {
  templates: OnbTemplate[]
  loading: boolean
  error: string | null
  onChanged: () => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)

  async function remove(t: OnbTemplate) {
    const warn =
      t.instance_count > 0
        ? `“${t.name}” has been used to start ${t.instance_count} checklist${t.instance_count === 1 ? '' : 's'}. Those checklists are copies and will not be affected. Delete the template?`
        : `Delete “${t.name}”?`
    if (!window.confirm(warn)) return
    setRowError(null)
    try {
      await api.del(`/onboarding/templates/${t.id}`)
      onChanged()
    } catch (err) {
      setRowError(errorText(err, 'Could not delete that template'))
    }
  }

  return (
    <section className="ob-panel">
      <div className="ob-panel-head">
        <div>
          <h2 className="ob-panel-title">Checklist templates</h2>
          <p className="ob-panel-sub">
            The starting point for a new hire's checklist, per department or org-wide.
          </p>
        </div>
        <button className="btn btn-sm btn-primary" onClick={() => {
          setEditingId(null)
          setCreating((v) => !v)
        }}>
          {creating ? 'Cancel' : 'New template'}
        </button>
      </div>

      <div className="ob-note" style={{ marginBottom: 12 }}>
        <b>A checklist is copied, not linked.</b> When onboarding starts, these tasks are copied
        onto the hire. Editing or deleting a template afterwards changes nothing for anybody
        already being onboarded — go to their checklist to change their tasks.
      </div>

      {rowError && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{rowError}</ErrorNote>
        </div>
      )}

      {(creating || editingId) && (
        <TemplateEditor
          key={editingId ?? 'new'}
          templateId={editingId}
          onCancel={() => {
            setCreating(false)
            setEditingId(null)
          }}
          onDone={() => {
            setCreating(false)
            setEditingId(null)
            onChanged()
          }}
        />
      )}

      {error ? (
        <ErrorNote>{errorText(error, 'Could not load templates')}</ErrorNote>
      ) : loading ? (
        <Loading />
      ) : templates.length === 0 ? (
        <EmptyState
          icon={<IconSheet size={22} />}
          title="No templates yet"
          body="A template is the list of steps a new joiner goes through — collect the PAN card, issue a laptop, book the induction. Build one and every hire in that department starts from the same checklist."
          action={
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              Build the first template
            </button>
          }
        />
      ) : (
        <div className="ob-tpl-list">
          {templates.map((t) => (
            <div className="ob-tpl" key={t.id}>
              <div className="ob-tpl-body">
                <div className="ob-tpl-name">
                  {t.name}
                  {!t.is_active && <span className="ob-tag" style={{ marginLeft: 8 }}>Inactive</span>}
                </div>
                <div className="ob-tpl-meta">
                  {t.department_name ?? 'Every department'} · {t.task_count} task
                  {t.task_count === 1 ? '' : 's'} ·{' '}
                  {t.instance_count === 0
                    ? 'never used'
                    : `${t.instance_count} checklist${t.instance_count === 1 ? '' : 's'} started from it`}
                </div>
              </div>
              <div className="ob-doc-actions">
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setCreating(false)
                    setEditingId(editingId === t.id ? null : t.id)
                  }}
                >
                  {editingId === t.id ? 'Close' : 'Edit'}
                </button>
                <button className="btn btn-sm" onClick={() => void remove(t)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

interface DraftTask {
  title: string
  category: string
  owner_role: string
  due_offset_days: number
  requires_document: boolean
  doc_type: string
}

function TemplateEditor({
  templateId,
  onCancel,
  onDone,
}: {
  templateId: string | null
  onCancel: () => void
  onDone: () => void
}) {
  const detail = useQuery<OnbTemplateDetail>(
    `onboarding-template-${templateId ?? 'new'}`,
    () => api.get<OnbTemplateDetail>(`/onboarding/templates/${templateId}`),
    { enabled: templateId !== null },
  )
  const departments = useQuery<Department[]>('org-departments', () =>
    api.get<Department[]>('/org/departments'),
  )
  const [form, setForm] = useState<{
    name: string
    description: string
    is_active: boolean
    department_id: string
  } | null>(null)
  const [tasks, setTasks] = useState<DraftTask[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /* Seeded from the fetched template the first render after it arrives. A
     useEffect would fight the user's own edits on every refetch. */
  const seededName = form ?? {
    name: detail.data?.name ?? '',
    description: detail.data?.description ?? '',
    is_active: detail.data?.is_active ?? true,
    department_id: detail.data?.department_id ?? '',
  }
  const seededTasks =
    tasks ??
    (detail.data?.tasks ?? []).map((t) => ({
      title: t.title,
      category: t.category,
      owner_role: t.owner_role,
      due_offset_days: t.due_offset_days,
      requires_document: t.requires_document,
      doc_type: t.doc_type ?? '',
    }))

  if (templateId && detail.loading) {
    return (
      <div className="ob-panel">
        <Loading label="Opening the template…" />
      </div>
    )
  }

  function setField<K extends keyof typeof seededName>(key: K, value: (typeof seededName)[K]) {
    setForm({ ...seededName, [key]: value })
  }

  function setTaskField<K extends keyof DraftTask>(index: number, key: K, value: DraftTask[K]) {
    const next = seededTasks.slice()
    next[index] = { ...next[index], [key]: value }
    setTasks(next)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const body = {
      name: seededName.name.trim(),
      description: seededName.description.trim() || null,
      department_id: seededName.department_id || null,
      is_active: seededName.is_active,
      tasks: seededTasks.map((t, index) => ({
        title: t.title.trim(),
        description: null,
        category: t.category,
        owner_role: t.owner_role,
        due_offset_days: t.due_offset_days,
        sort_order: index,
        requires_document: t.requires_document,
        doc_type: t.requires_document ? t.doc_type.trim() || null : null,
      })),
    }
    try {
      if (templateId) await api.put(`/onboarding/templates/${templateId}`, body)
      else await api.post('/onboarding/templates', body)
      onDone()
    } catch (err) {
      setError(errorText(err, 'Could not save the template'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ob-panel" onSubmit={submit}>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <div className="settings-grid">
        <label className="setting">
          Name
          <input
            value={seededName.name}
            onChange={(e) => setField('name', e.target.value)}
            placeholder="Engineering — new joiner"
            required
            autoFocus
          />
        </label>
        <label className="setting">
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={seededName.is_active}
              onChange={(e) => setField('is_active', e.target.checked)}
            />
            Active
          </span>
          <span className="setting-hint">
            Inactive templates stay on file and stay attached to the checklists already started
            from them; they are just not offered for new ones.
          </span>
        </label>
        <label className="setting">
          Department
          <select
            value={seededName.department_id}
            onChange={(e) => setField('department_id', e.target.value)}
          >
            <option value="">Every department</option>
            {(departments.data ?? []).map((dep) => (
              <option key={dep.id} value={dep.id}>
                {dep.name}
              </option>
            ))}
          </select>
          <span className="setting-hint">
            Left as “every department” this is the org-wide fallback — a deliberate and common
            choice, not “unassigned”. A department template is what the server reaches for when
            onboarding is started without naming one.
          </span>
        </label>
        <label className="setting" style={{ gridColumn: '1 / -1' }}>
          Description
          <textarea
            value={seededName.description}
            onChange={(e) => setField('description', e.target.value)}
            rows={2}
          />
        </label>
      </div>

      <div className="ob-panel-head" style={{ marginTop: 14, marginBottom: 8 }}>
        <div>
          <h3 className="ob-panel-title">Steps</h3>
          <p className="ob-panel-sub">
            Offsets are relative to the joining day. A negative offset is pre-boarding — “−7”
            means a week before they start.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() =>
            setTasks([
              ...seededTasks,
              {
                title: '',
                category: 'documentation',
                owner_role: 'hr',
                due_offset_days: 0,
                requires_document: false,
                doc_type: '',
              },
            ])
          }
        >
          Add step
        </button>
      </div>

      {seededTasks.length === 0 ? (
        <Empty>No steps yet. Add the first one.</Empty>
      ) : (
        <div className="ob-tpl-rows">
          {seededTasks.map((t, index) => (
            <div className="ob-tpl-row" key={index}>
              <input
                value={t.title}
                onChange={(e) => setTaskField(index, 'title', e.target.value)}
                placeholder="Step"
                aria-label={`Step ${index + 1} title`}
                required
              />
              <select
                value={t.category}
                onChange={(e) => setTaskField(index, 'category', e.target.value)}
                aria-label={`Step ${index + 1} section`}
              >
                {CATEGORY_ORDER.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
              <select
                value={t.owner_role}
                onChange={(e) => setTaskField(index, 'owner_role', e.target.value)}
                aria-label={`Step ${index + 1} owner`}
              >
                {Object.entries(OWNER_ROLE_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={-365}
                max={365}
                value={t.due_offset_days}
                onChange={(e) => setTaskField(index, 'due_offset_days', Number(e.target.value))}
                aria-label={`Step ${index + 1} day offset`}
                title="Days from the joining date. Negative = pre-boarding."
              />
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setTasks(seededTasks.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="btn-group" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : templateId ? 'Save template' : 'Create template'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
