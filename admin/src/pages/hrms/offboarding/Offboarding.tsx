import { useMemo, useState, type FormEvent } from 'react'
import '../../../styles/offboarding.css'
import { api, ApiError } from '../../../lib/api'
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
import { IconAlert, IconCheck, IconReturn, IconUsers } from '../../../components/Icons'

/* ---------------------------------------------------------------- types ---
   Page-local, mirroring app/schemas/offboarding.py. lib/types.ts is lead-owned
   and does not carry them. */

export interface ExitTask {
  id: string
  request_id: string
  title: string
  description: string | null
  category: string
  owner_role: string
  assignee_user_id: string | null
  status: string
  is_mandatory: boolean
  /** Relative to the last working day. Upheld by D-023 precisely so moving the
   *  last working day can recompute `due_on` — offboarding has no template
   *  table to hold the offset instead. */
  due_offset_days: number
  due_on: string | null
  sort_order: number
  completed_by: string | null
  completed_at: string | null
  notes: string | null
  created_at: string
  assignee_name: string | null
  completed_by_name: string | null
  /** Done or consciously skipped. Sent rather than inferred here so this page
   *  and the completion gate can never disagree about what "settled" means. */
  is_settled: boolean
}

export interface ClearanceGroup {
  category: string
  task_total: number
  task_settled: number
  blocking_task_count: number
  tasks: ExitTask[]
}

/** Every figure is integer **paise**. Nothing here is ever divided, added or
 *  compared as a float — see formatPaise/parseRupees below. */
export interface Fnf {
  id: string
  request_id: string
  gross_dues_paise: number
  deductions_paise: number
  net_payable_paise: number
  currency: string
  status: string
  notes: string | null
  prepared_by: string | null
  approved_by: string | null
  approved_at: string | null
  paid_on: string | null
  payment_reference: string | null
  paid_by: string | null
  created_at: string
  prepared_by_name: string | null
  approved_by_name: string | null
  paid_by_name: string | null
  /** False when net ≠ gross − deductions. **Advisory only.** Ex-gratia and
   *  negotiated write-offs make a mismatch legitimate, so this warns and never
   *  blocks, and nothing on this page auto-corrects a figure somebody typed. */
  is_consistent: boolean
  /** True when the three numbers were typed in rather than computed from a
   *  proposal — which is what `computed_at` being null means. Kept as its own
   *  field because it is the thing a reader needs to notice. */
  is_manually_entered: boolean
  /** Null on a settlement somebody typed in. Every settlement written before
   *  payroll existed has it null, which is accurate rather than a gap. */
  computed_at: string | null
  /** The itemisation. Empty on a typed-in settlement, and that emptiness is
   *  the honest answer to "what was this made of". */
  lines: FnfLine[]
}

export interface FnfLine {
  id: string
  /** `earning` or `deduction`. Amounts are always positive; the kind carries
   *  the sign, so no total has to know which convention a row followed. */
  kind: string
  code: string
  label: string
  amount_paise: number
  source: string
  source_id: string | null
  /** The working — "18.5 days at ₹1,923/day". What makes a settlement
   *  answerable when somebody queries it. */
  detail: string | null
  sort_order: number
}

/** A settlement as computed. Stored nowhere until somebody accepts it. */
export interface Proposal {
  request_id: string
  user_id: string
  user_name: string
  last_working_day: string
  lines: Array<Omit<FnfLine, 'id' | 'sort_order'>>
  gross_dues_paise: number
  deductions_paise: number
  /** May be negative — a leaver with a large loan owes the company money. */
  net_payable_paise: number
  /** Inputs that were missing and assumptions made in their place. Never
   *  empty: the income-tax note is always the last entry. */
  warnings: string[]
  tax_paid_ytd: number
  tax_deducted_ytd: number
  currency: string
}

export interface ExitRequest {
  id: string
  org_id: string
  user_id: string
  initiated_by: string | null
  reason: string
  reason_note: string | null
  notice_date: string
  last_working_day: string | null
  status: string
  completed_at: string | null
  completed_by: string | null
  cancelled_at: string | null
  cancellation_reason: string | null
  /** Evidence that completion did the two irreversible things. Never used to
   *  decide access — `devices.is_active` and `users.is_active` are. */
  devices_revoked_at: string | null
  user_deactivated_at: string | null
  created_at: string
  user_name: string | null
  user_email: string | null
  employee_code: string | null
  department_name: string | null
  designation_name: string | null
  manager_name: string | null
  initiated_by_name: string | null
  task_total: number
  task_settled: number
  /** Mandatory items still open. Non-zero means completion will be refused. */
  blocking_task_count: number
  fnf_status: string | null
}

export interface ExitDetail extends ExitRequest {
  clearance: ClearanceGroup[]
  fnf: Fnf | null
}

/** One row of GET /offboarding/requests/{id}/assets — the asset register's own
 *  shape, read straight from the register rather than re-derived here. */
export interface HeldAsset {
  id: string
  asset_tag: string
  category: string
  serial_number: string | null
  status: string
  current_holder_id: string | null
  current_holder_name: string | null
  current_assignment_id: string | null
  assigned_at: string | null
}

export interface Person {
  id: string
  full_name: string
  email: string
  is_active: boolean
  status?: string
}

/* ------------------------------------------------------------- labels --- */

const REASON_LABEL: Record<string, string> = {
  resignation: 'Resignation',
  termination: 'Termination',
  end_of_contract: 'End of contract',
}

const REQUEST_STATUS_LABEL: Record<string, string> = {
  initiated: 'Initiated',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Withdrawn',
}

const CLEARANCE_LABEL: Record<string, string> = {
  it_asset_return: 'IT — assets back',
  knowledge_transfer: 'Knowledge transfer',
  hr_clearance: 'HR clearance',
  finance_clearance: 'Finance clearance',
}

const CLEARANCE_HINT: Record<string, string> = {
  it_asset_return: 'Hardware still on the register under this person’s name.',
  knowledge_transfer: 'Handover of work in flight, to a named person.',
  hr_clearance: 'Exit interview, ID card, relieving paperwork.',
  finance_clearance: 'Advances, reimbursements, anything still owed either way.',
}

const TASK_STATUS_LABEL: Record<string, string> = {
  pending: 'Not started',
  in_progress: 'In progress',
  done: 'Done',
  skipped: 'Waived',
}

const OWNER_ROLE_LABEL: Record<string, string> = {
  hr: 'HR',
  manager: 'Manager',
  it: 'IT',
  employee: 'The leaver',
}

const FNF_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  approved: 'Approved',
  paid: 'Paid',
  cancelled: 'Cancelled',
}

const ASSET_CATEGORY_LABEL: Record<string, string> = {
  laptop: 'Laptop',
  monitor: 'Monitor',
  sim: 'SIM',
  id_card: 'ID card',
  other: 'Other',
}

/* ------------------------------------------------------------ helpers --- */

function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  const raw = String(err ?? '')
  return raw || fallback
}

/** The server's machine-readable cause. Branch on this, never on prose. */
function errorReason(err: unknown): string | undefined {
  return err instanceof ApiError ? err.reason : undefined
}

function permits(user: Record<string, unknown> | null, flag: string): boolean {
  if (!user) return false
  return user[flag] !== false
}

const CURRENCY_SYMBOL: Record<string, string> = {
  INR: '₹',
  USD: '$',
  GBP: '£',
  EUR: '€',
}

/**
 * Integer paise → a string a person reads.
 *
 * Deliberately never `amount / 100`. The rupee and paise halves are split with
 * integer division and re-joined as text, so no figure on this page has ever
 * been through a float. A settlement is the last money a company owes somebody
 * and a rounding dispute here is one somebody files.
 */
export function formatPaise(amount: number, currency: string): string {
  const negative = amount < 0
  const abs = Math.abs(Math.trunc(amount))
  const whole = Math.floor(abs / 100)
  const fraction = abs % 100
  const grouped = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : undefined).format(whole)
  const symbol = CURRENCY_SYMBOL[currency] ?? `${currency} `
  return `${negative ? '−' : ''}${symbol}${grouped}.${String(fraction).padStart(2, '0')}`
}

/** Typed rupees → integer paise, or null when the text is not a number. Parsed
 *  by string surgery for the same reason format is: `Number('12.30') * 100` is
 *  1229.9999999999998 on some inputs, and this figure gets paid. */
export function parseRupees(input: string): number | null {
  const text = input.trim().replace(/[,\s]/g, '')
  if (text === '') return 0
  const match = /^(-)?(\d+)?(?:\.(\d{0,2}))?$/.exec(text)
  if (!match) return null
  if (match[2] === undefined && match[3] === undefined) return null
  const sign = match[1] ? -1 : 1
  const whole = match[2] ?? '0'
  const fraction = (match[3] ?? '').padEnd(2, '0')
  return sign * (Number(whole) * 100 + Number(fraction))
}

/** Integer paise → the text that goes back into a rupee input. */
export function paiseToInput(amount: number): string {
  const negative = amount < 0
  const abs = Math.abs(Math.trunc(amount))
  return `${negative ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** Date arithmetic in UTC so a DST boundary cannot move a due date by a day. */
function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

/**
 * Whether this item's due date has been moved off its offset by hand.
 *
 * Worth knowing before the last working day changes: moving it recomputes
 * every `due_on` from `due_offset_days` (D-023), which silently overwrites
 * exactly these.
 */
function isHandSet(task: ExitTask, lastWorkingDay: string | null): boolean {
  if (!lastWorkingDay || !task.due_on) return false
  return task.due_on !== addDays(lastWorkingDay, task.due_offset_days)
}

function blockersOf(detail: ExitDetail): Array<{ id: string; title: string; category: string }> {
  return detail.clearance
    .flatMap((g) => g.tasks)
    .filter((t) => t.is_mandatory && !t.is_settled)
    .map((t) => ({ id: t.id, title: t.title, category: t.category }))
}

/* ------------------------------------------------------------- pieces --- */

function StatusPill({ value }: { value: string }) {
  return (
    <span className={`ex-pill ex-${value}`}>
      <span className="ex-pill-dot" style={{ background: 'currentColor' }} />
      {REQUEST_STATUS_LABEL[value] ?? value}
    </span>
  )
}

function ReasonTag({ value }: { value: string }) {
  return (
    <span className={`ex-reason${value === 'termination' ? ' ex-reason-termination' : ''}`}>
      {REASON_LABEL[value] ?? value}
    </span>
  )
}

function TaskTick({ status }: { status: string }) {
  const cls =
    status === 'done'
      ? 'ex-tick ex-tick-done'
      : status === 'skipped'
        ? 'ex-tick ex-tick-skipped'
        : status === 'in_progress'
          ? 'ex-tick ex-tick-progress'
          : 'ex-tick'
  return (
    <span className={cls} aria-hidden="true">
      {status === 'done' && <IconCheck size={11} />}
    </span>
  )
}

/* ----------------------------------------------------------------- page --- */

export default function Offboarding() {
  const { user } = useAuth()
  const allowed =
    canAdminister(user) &&
    permits(user as unknown as Record<string, unknown> | null, 'can_manage_onboarding')

  const [openOnly, setOpenOnly] = useState(true)

  const exits = useQuery<ExitRequest[]>(
    `offboarding-requests-${openOnly}`,
    () => api.get<ExitRequest[]>(`/offboarding/requests?open_only=${openOnly}`),
    { enabled: allowed },
  )
  const people = useQuery<Person[]>('employees', () => api.get<Person[]>('/admin/employees'), {
    enabled: allowed,
  })

  const [initiating, setInitiating] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (exits.data ?? []).filter((r) => {
      if (statusFilter && r.status !== statusFilter) return false
      if (!needle) return true
      return (
        (r.user_name ?? '').toLowerCase().includes(needle) ||
        (r.user_email ?? '').toLowerCase().includes(needle) ||
        (r.employee_code ?? '').toLowerCase().includes(needle) ||
        (r.department_name ?? '').toLowerCase().includes(needle)
      )
    })
  }, [exits.data, q, statusFilter])

  const counts = useMemo(() => {
    const all = exits.data ?? []
    const open = all.filter((r) => r.status === 'initiated' || r.status === 'in_progress')
    return {
      open: open.length,
      blocking: open.reduce((n, r) => n + r.blocking_task_count, 0),
      noLwd: open.filter((r) => !r.last_working_day).length,
      settlements: open.filter((r) => r.fnf_status === 'draft' || r.fnf_status === 'approved')
        .length,
    }
  }, [exits.data])

  if (!allowed) {
    return (
      <div>
        <div className="page-head">
          <h1 className="page-title">Offboarding</h1>
        </div>
        <section className="card">
          <EmptyState
            icon={<IconUsers size={22} />}
            title="Exits are not open to your account"
            body="An exit record carries why somebody was terminated, their manager's handover notes and the last money the company owes them. There is no employee-facing half of this screen — it is administrator-only, reads included."
          />
        </section>
      </div>
    )
  }

  if (exits.error) {
    return <ErrorNote>{errorText(exits.error, 'Could not load exits')}</ErrorNote>
  }

  const filtered = q !== '' || statusFilter !== ''

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Offboarding</h1>
          <p className="page-sub">
            Exits in flight, the clearance each one is waiting on, and the settlement at the end
            of it. An exit cannot be closed while a mandatory clearance item is still open — and
            closing it revokes the person's devices and switches their account off.
          </p>
        </div>
        <div className="head-actions">
          <button className="btn btn-primary" onClick={() => setInitiating((v) => !v)}>
            {initiating ? 'Cancel' : 'Raise an exit'}
          </button>
        </div>
      </div>

      {(exits.data ?? []).length > 0 && (
        <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
          <StatTile label="Exits in flight" value={String(counts.open)} accent="var(--brand)" />
          <StatTile
            label="Blocking clearance"
            value={String(counts.blocking)}
            meta={counts.blocking ? 'mandatory items still open' : 'nothing outstanding'}
            accent={counts.blocking ? 'var(--status-warn)' : undefined}
          />
          <StatTile
            label="No last working day"
            value={String(counts.noLwd)}
            meta={counts.noLwd ? 'cannot be completed yet' : undefined}
            accent={counts.noLwd ? 'var(--status-critical)' : undefined}
          />
          <StatTile
            label="Settlements open"
            value={String(counts.settlements)}
            meta={counts.settlements ? 'draft or approved, not paid' : undefined}
          />
        </div>
      )}

      {initiating && (
        <InitiateForm
          people={people.data ?? []}
          onCancel={() => setInitiating(false)}
          onDone={(created) => {
            setInitiating(false)
            setOpenId(created.id)
            exits.reload()
          }}
        />
      )}

      <div className="filter-row">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search leaver, code, department…"
          aria-label="Search exits"
          style={{ minWidth: 220 }}
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Exit status"
        >
          <option value="">Any status</option>
          {Object.entries(REQUEST_STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <label className="ex-muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={openOnly}
            onChange={(e) => setOpenOnly(e.target.checked)}
          />
          Only exits still in flight
        </label>
        <span className="filter-count">
          {rows.length} of {(exits.data ?? []).length}
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

      <section className="card" style={{ opacity: exits.refetching ? 0.6 : 1 }}>
        {rows.length === 0 ? (
          exits.loading ? (
            <Loading />
          ) : filtered ? (
            <EmptyState
              icon={<IconUsers size={22} />}
              title="No exit matches"
              body="Clear the filters, or untick “only exits still in flight” — a completed or withdrawn exit is not in this list by default."
            />
          ) : openOnly ? (
            <EmptyState
              icon={<IconUsers size={22} />}
              title="Nobody is leaving"
              body="When a resignation comes in, raise it here and the clearance checklist is laid out with it — assets back, handover done, HR and finance signed off — so nothing gets remembered on the last day."
              action={
                <button className="btn btn-primary" onClick={() => setInitiating(true)}>
                  Raise the first exit
                </button>
              }
            />
          ) : (
            <EmptyState
              icon={<IconUsers size={22} />}
              title="No exits on record"
              body="Nobody has left, and nobody is leaving. Exits raised here stay on file after they close — a withdrawn resignation is history somebody may need later."
            />
          )
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Leaver</th>
                  <th>Reason</th>
                  <th>Status</th>
                  <th>Last day</th>
                  <th>Clearance</th>
                  <th>Settlement</th>
                  <th style={{ textAlign: 'right' }}>Exit</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className={`ex-row-click${openId === row.id ? ' ex-row-open' : ''}`}
                    onClick={() => setOpenId(openId === row.id ? null : row.id)}
                  >
                    <td>
                      <Identity
                        name={row.user_name ?? 'Unknown'}
                        small
                        meta={
                          <>
                            {row.employee_code ? `${row.employee_code} · ` : ''}
                            {row.department_name ?? row.user_email}
                          </>
                        }
                      />
                    </td>
                    <td>
                      <ReasonTag value={row.reason} />
                    </td>
                    <td>
                      <StatusPill value={row.status} />
                    </td>
                    <td className="ex-when">
                      {row.last_working_day ? (
                        shortDate(row.last_working_day)
                      ) : (
                        <span className="ex-blocking">not set</span>
                      )}
                    </td>
                    <td>
                      <div className="ex-progress">
                        <Meter value={row.task_settled} max={row.task_total} />
                        <span className="ex-progress-pct">
                          {row.task_total
                            ? Math.round((row.task_settled * 100) / row.task_total)
                            : 0}
                          %
                        </span>
                      </div>
                      <div style={{ marginTop: 4 }}>
                        {row.blocking_task_count > 0 ? (
                          <span className="ex-blocking">
                            <IconAlert size={11} /> {row.blocking_task_count} blocking
                          </span>
                        ) : (
                          <span className="ex-clear">nothing blocking</span>
                        )}
                      </div>
                    </td>
                    <td className="ex-muted">
                      {row.fnf_status ? FNF_STATUS_LABEL[row.fnf_status] ?? row.fnf_status : '—'}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="ex-actions">
                        <button
                          className="btn btn-sm"
                          onClick={() => setOpenId(openId === row.id ? null : row.id)}
                        >
                          {openId === row.id ? 'Close' : 'Open'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {openId && (
        <ExitDetailPanel
          key={openId}
          requestId={openId}
          people={people.data ?? []}
          onClose={() => setOpenId(null)}
          onChanged={() => exits.reload()}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------- initiate --- */

function InitiateForm({
  people,
  onCancel,
  onDone,
}: {
  people: Person[]
  onCancel: () => void
  onDone: (created: ExitDetail) => void
}) {
  const [userId, setUserId] = useState('')
  const [reason, setReason] = useState('resignation')
  const [reasonNote, setReasonNote] = useState('')
  const [noticeDate, setNoticeDate] = useState('')
  const [lastDay, setLastDay] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const created = await api.post<ExitDetail>('/offboarding/requests', {
        user_id: userId,
        reason,
        reason_note: reasonNote.trim() || null,
        notice_date: noticeDate,
        last_working_day: lastDay || null,
      })
      onDone(created)
    } catch (err) {
      setError(errorText(err, 'Could not raise this exit'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ex-panel" onSubmit={submit}>
      <div className="ex-panel-head">
        <div>
          <h2 className="ex-panel-title">Raise an exit</h2>
          <p className="ex-panel-sub">
            The clearance checklist is laid out at the same moment, never afterwards. Nothing is
            revoked and nobody is deactivated by raising an exit — that happens only when you
            complete it.
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
          Leaver
          <select value={userId} onChange={(e) => setUserId(e.target.value)} required autoFocus>
            <option value="">Choose an employee…</option>
            {people
              .filter((p) => p.status !== 'inactive')
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name}
                </option>
              ))}
          </select>
        </label>
        <label className="setting">
          Reason
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            {Object.entries(REASON_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="setting">
          Notice received
          <input
            type="date"
            value={noticeDate}
            onChange={(e) => setNoticeDate(e.target.value)}
            required
          />
        </label>
        <label className="setting">
          Last working day
          <input type="date" value={lastDay} onChange={(e) => setLastDay(e.target.value)} />
          <span className="setting-hint">
            Optional now: the last day is negotiated after a resignation is accepted far more
            often than it is known on day one. Every clearance due date is derived from it, so
            setting it later reschedules the checklist.
          </span>
        </label>
        <label className="setting" style={{ gridColumn: '1 / -1' }}>
          Note
          <textarea
            value={reasonNote}
            onChange={(e) => setReasonNote(e.target.value)}
            rows={2}
            placeholder="Context for whoever reads this record later."
          />
        </label>
      </div>

      <div className="btn-group" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy || !userId || !noticeDate}>
          {busy ? 'Raising…' : 'Raise the exit'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/* --------------------------------------------------------------- detail --- */

type Refusal = { reason?: string; message: string; blockers: Array<{ id: string; title: string; category: string }> }

function ExitDetailPanel({
  requestId,
  people,
  onClose,
  onChanged,
}: {
  requestId: string
  people: Person[]
  onClose: () => void
  onChanged: () => void
}) {
  const detail = useQuery<ExitDetail>(`offboarding-request-${requestId}`, () =>
    api.get<ExitDetail>(`/offboarding/requests/${requestId}`),
  )
  const [panelError, setPanelError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [addingTo, setAddingTo] = useState<string | null>(null)

  function reload() {
    setPanelError(null)
    detail.reload()
    onChanged()
  }

  if (detail.loading) {
    return (
      <section className="card" style={{ marginTop: 16 }}>
        <Loading label="Opening the exit…" />
      </section>
    )
  }
  if (detail.error || !detail.data) {
    return (
      <section className="card" style={{ marginTop: 16 }}>
        <ErrorNote>{errorText(detail.error, 'Could not open this exit')}</ErrorNote>
      </section>
    )
  }

  const d = detail.data
  const open = d.status === 'initiated' || d.status === 'in_progress'
  const blockers = blockersOf(d)

  return (
    <section className="card" style={{ marginTop: 16, opacity: detail.refetching ? 0.7 : 1 }}>
      <div className="card-head">
        <div>
          <h2 className="card-title">{d.user_name ?? 'Exit'}</h2>
          <div className="ex-muted" style={{ marginTop: 3 }}>
            {d.employee_code ? `${d.employee_code} · ` : ''}
            {d.designation_name ? `${d.designation_name} · ` : ''}
            {d.department_name ?? d.user_email}
            {d.manager_name ? ` · reports to ${d.manager_name}` : ''}
          </div>
          <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <StatusPill value={d.status} />
            <ReasonTag value={d.reason} />
            <span className="ex-muted">
              Notice {shortDate(d.notice_date)}
              {' · '}
              {d.last_working_day ? (
                <>last day {shortDate(d.last_working_day)}</>
              ) : (
                <b>last working day not set</b>
              )}
            </span>
          </div>
        </div>
        <div className="card-tools">
          {open && (
            <>
              <button className="btn btn-sm" onClick={() => setEditing((v) => !v)}>
                {editing ? 'Cancel edit' : 'Edit'}
              </button>
              <button className="btn btn-sm" onClick={() => setCancelling((v) => !v)}>
                Withdraw
              </button>
              <button
                className="btn btn-sm ex-danger-btn"
                onClick={() => {
                  setRefusal(null)
                  setCompleting((v) => !v)
                }}
              >
                Complete exit
              </button>
            </>
          )}
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {d.reason_note && (
        <div className="ex-task-note" style={{ marginBottom: 14 }}>
          <span className="ex-task-note-label">Note on the reason</span>
          {d.reason_note}
        </div>
      )}

      {d.status === 'cancelled' && (
        <div className="ex-note" style={{ marginBottom: 14 }}>
          <b>Withdrawn {d.cancelled_at ? dateTime(d.cancelled_at) : ''}.</b>{' '}
          {d.cancellation_reason}
        </div>
      )}

      {d.status === 'completed' && (
        <div className="ex-note" style={{ marginBottom: 14 }}>
          <b>Exit completed {d.completed_at ? dateTime(d.completed_at) : ''}.</b>
          <ul>
            <li>
              Devices revoked{' '}
              {d.devices_revoked_at ? dateTime(d.devices_revoked_at) : 'not recorded'}
            </li>
            <li>
              Account deactivated{' '}
              {d.user_deactivated_at ? dateTime(d.user_deactivated_at) : 'not recorded'}
            </li>
          </ul>
        </div>
      )}

      {panelError && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{panelError}</ErrorNote>
        </div>
      )}

      {editing && (
        <EditForm
          detail={d}
          onCancel={() => setEditing(false)}
          onDone={() => {
            setEditing(false)
            reload()
          }}
        />
      )}

      {cancelling && (
        <CancelForm
          requestId={d.id}
          name={d.user_name ?? 'this employee'}
          onCancel={() => setCancelling(false)}
          onDone={() => {
            setCancelling(false)
            reload()
          }}
        />
      )}

      {completing && (
        <CompletePanel
          detail={d}
          blockers={blockers}
          refusal={refusal}
          onRefused={setRefusal}
          onCancel={() => setCompleting(false)}
          onDone={() => {
            setCompleting(false)
            setRefusal(null)
            reload()
          }}
        />
      )}

      <div className="ex-groups" style={{ marginTop: 4 }}>
        {d.clearance.map((group) => (
          <ClearanceSection
            key={group.category}
            group={group}
            detail={d}
            people={people}
            readOnly={!open}
            adding={addingTo === group.category}
            onAdd={() => setAddingTo(addingTo === group.category ? null : group.category)}
            onError={setPanelError}
            onChanged={reload}
          />
        ))}
      </div>

      <FnfPanel detail={d} onError={setPanelError} onChanged={reload} />
    </section>
  )
}

/* ----------------------------------------------------------------- edit --- */

/**
 * Editing an in-flight exit.
 *
 * The last-working-day warning is not decoration. Moving it recomputes every
 * clearance due date from its offset (D-023), which overwrites any date
 * somebody set by hand — and an HR admin nudging a date by one day should not
 * silently lose a rota of overrides they spent an afternoon on. The count is
 * derived from the same arithmetic the server will use.
 */
function EditForm({
  detail,
  onCancel,
  onDone,
}: {
  detail: ExitDetail
  onCancel: () => void
  onDone: () => void
}) {
  const [reason, setReason] = useState(detail.reason)
  const [reasonNote, setReasonNote] = useState(detail.reason_note ?? '')
  const [noticeDate, setNoticeDate] = useState(detail.notice_date)
  const [lastDay, setLastDay] = useState(detail.last_working_day ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const currentLwd = detail.last_working_day ?? ''
  const lwdMoved = lastDay !== currentLwd
  const allTasks = detail.clearance.flatMap((g) => g.tasks)
  const handSet = allTasks.filter((t) => isHandSet(t, detail.last_working_day))

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.patch(`/offboarding/requests/${detail.id}`, {
        reason,
        reason_note: reasonNote.trim() || null,
        notice_date: noticeDate,
        last_working_day: lastDay || null,
      })
      onDone()
    } catch (err) {
      setError(errorText(err, 'Could not save this exit'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ex-panel" onSubmit={submit}>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <div className="settings-grid">
        <label className="setting">
          Reason
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            {Object.entries(REASON_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="setting">
          Notice received
          <input
            type="date"
            value={noticeDate}
            onChange={(e) => setNoticeDate(e.target.value)}
            required
          />
        </label>
        <label className="setting">
          Last working day
          <input type="date" value={lastDay} onChange={(e) => setLastDay(e.target.value)} />
          <span className="setting-hint">
            The anchor for every clearance due date. It cannot fall before the notice date.
          </span>
        </label>
        <label className="setting" style={{ gridColumn: '1 / -1' }}>
          Note
          <textarea value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} rows={2} />
        </label>
      </div>

      {lwdMoved && (
        <div className="ex-note ex-note-warn" style={{ marginTop: 12 }}>
          <b>Saving this moves the whole clearance checklist.</b> All {allTasks.length} item
          {allTasks.length === 1 ? '' : 's'} get a new due date, recomputed from their own offset
          against{' '}
          {lastDay ? <b>{shortDate(lastDay)}</b> : <b>no last working day</b>}.
          {handSet.length > 0 && (
            <>
              {' '}
              <b>
                {handSet.length} due date{handSet.length === 1 ? '' : 's'} you set by hand will be
                overwritten:
              </b>
              <ul>
                {handSet.slice(0, 6).map((t) => (
                  <li key={t.id}>
                    {t.title} — currently {t.due_on ? shortDate(t.due_on) : 'unset'}
                  </li>
                ))}
                {handSet.length > 6 && <li>…and {handSet.length - 6} more</li>}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="btn-group" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : lwdMoved ? 'Save and reschedule' : 'Save'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function CancelForm({
  requestId,
  name,
  onCancel,
  onDone,
}: {
  requestId: string
  name: string
  onCancel: () => void
  onDone: () => void
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post(`/offboarding/requests/${requestId}/cancel`, {
        cancellation_reason: reason.trim(),
      })
      onDone()
    } catch (err) {
      setError(errorText(err, 'Could not withdraw this exit'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ex-panel" onSubmit={submit}>
      <div className="ex-panel-head">
        <div>
          <h2 className="ex-panel-title">Withdraw {name}'s exit</h2>
          <p className="ex-panel-sub">
            The record is kept, not deleted — a withdrawn resignation is history somebody may need
            six months from now. Nothing is revoked and nobody is deactivated.
          </p>
        </div>
      </div>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <label className="setting">
        Why is it being withdrawn?
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          placeholder="Resignation retracted after a counter-offer."
          required
          autoFocus
        />
      </label>
      <div className="btn-group" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" disabled={busy || !reason.trim()}>
          {busy ? 'Withdrawing…' : 'Withdraw the exit'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/* ------------------------------------------------------------- complete --- */

/**
 * Completing the exit.
 *
 * Two things happen here that cannot be undone from this screen: every device
 * the leaver holds is revoked, and their account is switched off. Both are said
 * at the point of action, not in a tooltip.
 *
 * The server refuses completion with a typed body in three cases and this panel
 * renders each of them properly:
 *
 * - `clearance_incomplete` — the blocking items are named. That naming is the
 *   entire value of the refusal, so they are also listed *before* the button is
 *   pressed, derived from the same rule the server applies (mandatory and not
 *   settled). A refusal the admin could have seen coming is a refusal that
 *   should have been shown.
 * - `last_working_day_missing` — refused rather than defaulted, because a
 *   relieving letter with a guessed date is worse than no letter.
 * - `last_administrator` — completing the only admin's exit would lock the
 *   whole tenant out of its own console. Promoting somebody is one edit away.
 */
function CompletePanel({
  detail,
  blockers,
  refusal,
  onRefused,
  onCancel,
  onDone,
}: {
  detail: ExitDetail
  blockers: Array<{ id: string; title: string; category: string }>
  refusal: Refusal | null
  onRefused: (r: Refusal | null) => void
  onCancel: () => void
  onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const missingLwd = !detail.last_working_day
  const willRefuse = blockers.length > 0 || missingLwd

  async function submit() {
    setBusy(true)
    onRefused(null)
    try {
      await api.post(`/offboarding/requests/${detail.id}/complete`)
      onDone()
    } catch (err) {
      const reason = errorReason(err)
      onRefused({
        reason,
        message: errorText(err, 'Could not complete this exit'),
        /* `blocking_tasks` travels on the 409 body but `lib/api.ts` keeps only
           `reason` and `message`, so the list is rebuilt from the checklist on
           screen using the server's own rule. Same set, same order the reader
           is already looking at. */
        blockers: reason === 'clearance_incomplete' ? blockersOf(detail) : [],
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ex-panel">
      <div className="ex-panel-head">
        <div>
          <h2 className="ex-panel-title">Complete {detail.user_name ?? 'this'} exit</h2>
        </div>
      </div>

      <div className="ex-note ex-note-danger">
        <b>This does two things that cannot be undone from this screen.</b>
        <ul>
          <li>
            Every device {detail.user_name ?? 'this person'} holds is revoked — the desktop agent
            stops collecting and will refuse to start again.
          </li>
          <li>
            Their account is deactivated. They can no longer sign in, and their employment status
            moves to inactive.
          </li>
        </ul>
      </div>

      {missingLwd && (
        <div className="ex-note ex-note-warn" style={{ marginTop: 12 }}>
          <b>No last working day is set.</b> Completion is refused without it: a completed exit
          with no leaving date cannot produce a relieving letter, and a guessed date on that
          letter is worse than none. Set it under Edit first.
        </div>
      )}

      {blockers.length > 0 && (
        <div className="ex-note ex-note-warn" style={{ marginTop: 12 }}>
          <b>
            {blockers.length} mandatory clearance item{blockers.length === 1 ? '' : 's'} still
            open.
          </b>{' '}
          Complete or waive each of these first — waiving is a legitimate answer and needs a
          reason on file.
          <div className="ex-blockers">
            {blockers.map((t) => (
              <div className="ex-blocker" key={t.id}>
                <span className="ex-blocker-cat">
                  {CLEARANCE_LABEL[t.category] ?? t.category}
                </span>
                <span>{t.title}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {refusal && (
        <div className="ex-note ex-note-danger" style={{ marginTop: 12 }}>
          <b>Refused.</b> {refusal.message}
          {refusal.reason === 'clearance_incomplete' && refusal.blockers.length > 0 && (
            <div className="ex-blockers">
              {refusal.blockers.map((t) => (
                <div className="ex-blocker" key={t.id}>
                  <span className="ex-blocker-cat">
                    {CLEARANCE_LABEL[t.category] ?? t.category}
                  </span>
                  <span>{t.title}</span>
                </div>
              ))}
            </div>
          )}
          {refusal.reason === 'last_administrator' && (
            <div style={{ marginTop: 6 }}>
              Promote another employee to administrator on the Employees page, then complete this
              exit. The exit itself is fine to have raised — a founder leaving is a real exit.
            </div>
          )}
        </div>
      )}

      <div className="btn-group" style={{ marginTop: 14 }}>
        <button
          className="btn ex-danger-btn"
          disabled={busy || willRefuse}
          onClick={() => void submit()}
        >
          {busy ? 'Completing…' : 'Revoke devices and close this exit'}
        </button>
        <button className="btn" onClick={onCancel}>
          Not yet
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ clearance --- */

function ClearanceSection({
  group,
  detail,
  people,
  readOnly,
  adding,
  onAdd,
  onError,
  onChanged,
}: {
  group: ClearanceGroup
  detail: ExitDetail
  people: Person[]
  readOnly: boolean
  adding: boolean
  onAdd: () => void
  onError: (msg: string | null) => void
  onChanged: () => void
}) {
  const [editing, setEditing] = useState<ExitTask | null>(null)

  return (
    <div className="ex-group">
      <div className="ex-group-head">
        <div>
          <div className="ex-group-name">{CLEARANCE_LABEL[group.category] ?? group.category}</div>
          <div className="ex-muted" style={{ marginTop: 2 }}>
            {CLEARANCE_HINT[group.category]}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className="ex-group-counts">
            {group.task_settled} of {group.task_total} settled
            {group.blocking_task_count > 0 ? ` · ${group.blocking_task_count} blocking` : ''}
          </span>
          {!readOnly && (
            <button className="btn btn-sm" onClick={onAdd}>
              {adding ? 'Cancel' : 'Add item'}
            </button>
          )}
        </div>
      </div>

      {group.tasks.length === 0 ? (
        <Empty>
          Nothing raised at this desk. An empty section is information — it means nobody has
          anything outstanding here.
        </Empty>
      ) : (
        group.tasks.map((task) =>
          editing?.id === task.id ? (
            <div key={task.id} style={{ padding: '0 14px 12px' }}>
              <ClearanceTaskForm
                requestId={detail.id}
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
            <ClearanceTaskRow
              key={task.id}
              task={task}
              detail={detail}
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
          <ClearanceTaskForm
            requestId={detail.id}
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

      {group.category === 'it_asset_return' && !readOnly && (
        <OutstandingAssets detail={detail} group={group} onError={onError} onChanged={onChanged} />
      )}
    </div>
  )
}

function ClearanceTaskRow({
  task,
  detail,
  readOnly,
  onEdit,
  onError,
  onChanged,
}: {
  task: ExitTask
  detail: ExitDetail
  readOnly: boolean
  onEdit: () => void
  onError: (msg: string | null) => void
  onChanged: () => void
}) {
  const [waiving, setWaiving] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function setStatus(next: string, notes?: string) {
    setBusy(true)
    onError(null)
    try {
      await api.patch(`/offboarding/requests/${task.request_id}/tasks/${task.id}`, {
        status: next,
        ...(notes !== undefined ? { notes } : {}),
      })
      setWaiving(false)
      setNote('')
      onChanged()
    } catch (err) {
      onError(errorText(err, 'Could not update this clearance item'))
    } finally {
      setBusy(false)
    }
  }

  const rowClass =
    task.status === 'done'
      ? 'ex-task ex-task-settled'
      : task.status === 'skipped'
        ? 'ex-task ex-task-skipped'
        : 'ex-task'
  const handSet = isHandSet(task, detail.last_working_day)

  return (
    <div className={rowClass}>
      <TaskTick status={task.status} />

      <div className="ex-task-body">
        <div className="ex-task-title">{task.title}</div>
        {task.description && <div className="ex-task-desc">{task.description}</div>}

        <div className="ex-task-meta">
          <span className={`ex-tag ${task.is_mandatory ? 'ex-tag-mandatory' : 'ex-tag-optional'}`}>
            {task.is_mandatory ? 'Mandatory' : 'Optional'}
          </span>
          <span>
            Owner <b>{OWNER_ROLE_LABEL[task.owner_role] ?? task.owner_role}</b>
          </span>
          {task.assignee_name && (
            <span>
              Assigned to <b>{task.assignee_name}</b>
            </span>
          )}
          {task.due_on ? (
            <span>
              Due {shortDate(task.due_on)}{' '}
              <span className="ex-muted">
                ({task.due_offset_days === 0
                  ? 'on the last day'
                  : task.due_offset_days < 0
                    ? `${-task.due_offset_days}d before the last day`
                    : `${task.due_offset_days}d after the last day`}
                )
              </span>
            </span>
          ) : (
            <span className="ex-muted">No due date — the last working day is not set</span>
          )}
          {handSet && (
            <span className="ex-tag ex-tag-override" title="Moving the last working day will overwrite this date">
              date set by hand
            </span>
          )}
          {task.completed_at && (
            <span>
              {task.status === 'skipped' ? 'Waived' : 'Done'} {dateTime(task.completed_at)}
              {task.completed_by_name ? ` by ${task.completed_by_name}` : ''}
            </span>
          )}
        </div>

        {task.notes && (
          <div className="ex-task-note">
            <span className="ex-task-note-label">
              {task.status === 'skipped' ? 'Why this was waived' : 'Note'}
            </span>
            {task.notes}
          </div>
        )}

        {waiving && (
          <div className="ex-inline-form">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why is this being waived? “Employee absconded, laptop written off” — the reason is the audit half of the waiver."
              autoFocus
            />
            <div className="btn-group">
              <button
                className="btn btn-sm btn-primary"
                disabled={busy || !note.trim()}
                onClick={() => void setStatus('skipped', note.trim())}
              >
                {busy ? 'Saving…' : 'Waive this item'}
              </button>
              <button className="btn btn-sm" onClick={() => setWaiving(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="ex-task-side">
        {readOnly ? (
          <span className="ex-tag">{TASK_STATUS_LABEL[task.status] ?? task.status}</span>
        ) : (
          <div className="ex-task-controls">
            <select
              value={task.status}
              disabled={busy}
              aria-label={`Status of ${task.title}`}
              onChange={(e) => {
                const next = e.target.value
                if (next === task.status) return
                if (next === 'skipped') {
                  setWaiving(true)
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
            <button className="btn btn-sm" onClick={onEdit}>
              Edit
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function ClearanceTaskForm({
  requestId,
  category,
  people,
  task,
  onCancel,
  onDone,
}: {
  requestId: string
  category: string
  people: Person[]
  task: ExitTask | null
  onCancel: () => void
  onDone: () => void
}) {
  const [form, setForm] = useState({
    title: task?.title ?? '',
    description: task?.description ?? '',
    owner_role: task?.owner_role ?? 'hr',
    assignee_user_id: task?.assignee_user_id ?? '',
    is_mandatory: task?.is_mandatory ?? true,
    due_offset_days: task?.due_offset_days ?? 0,
    due_on: task?.due_on ?? '',
    sort_order: task?.sort_order ?? 0,
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (task) {
        await api.patch(`/offboarding/requests/${requestId}/tasks/${task.id}`, {
          title: form.title.trim(),
          description: form.description.trim() || null,
          owner_role: form.owner_role,
          assignee_user_id: form.assignee_user_id || null,
          is_mandatory: form.is_mandatory,
          due_offset_days: form.due_offset_days,
          due_on: form.due_on || null,
          sort_order: form.sort_order,
        })
      } else {
        await api.post(`/offboarding/requests/${requestId}/tasks`, {
          title: form.title.trim(),
          description: form.description.trim() || null,
          category,
          owner_role: form.owner_role,
          assignee_user_id: form.assignee_user_id || null,
          is_mandatory: form.is_mandatory,
          due_offset_days: form.due_offset_days,
          sort_order: form.sort_order,
        })
      }
      onDone()
    } catch (err) {
      setError(errorText(err, 'Could not save this clearance item'))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!task) return
    setBusy(true)
    setError(null)
    try {
      await api.del(`/offboarding/requests/${requestId}/tasks/${task.id}`)
      onDone()
    } catch (err) {
      setError(errorText(err, 'Could not delete this clearance item'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ex-panel" style={{ marginBottom: 0 }} onSubmit={submit}>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <div className="settings-grid">
        <label className="setting" style={{ gridColumn: '1 / -1' }}>
          Item
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="Return the office key"
            required
            autoFocus
          />
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
        </label>
        <label className="setting">
          Days from the last working day
          <input
            type="number"
            min={-365}
            max={365}
            value={form.due_offset_days}
            onChange={(e) => setForm({ ...form, due_offset_days: Number(e.target.value) })}
          />
          <span className="setting-hint">
            Negative is before the last day. This offset is what the due date is recomputed from
            whenever the last working day moves.
          </span>
        </label>
        {task && (
          <label className="setting">
            Due date
            <input
              type="date"
              value={form.due_on}
              onChange={(e) => setForm({ ...form, due_on: e.target.value })}
            />
            <span className="setting-hint">
              Setting this by hand overrides the offset — until the last working day changes, at
              which point it is recomputed and this date is lost.
            </span>
          </label>
        )}
        <label className="setting">
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={form.is_mandatory}
              onChange={(e) => setForm({ ...form, is_mandatory: e.target.checked })}
            />
            Mandatory
          </span>
          <span className="setting-hint">
            A mandatory item blocks completion of the exit until it is done or waived.
          </span>
        </label>
        <label className="setting" style={{ gridColumn: '1 / -1' }}>
          Description
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            rows={2}
          />
        </label>
      </div>

      <div className="btn-group" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : task ? 'Save item' : 'Add item'}
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

/* ------------------------------------------------------- assets in hand --- */

/**
 * What the leaver is still holding, read straight from the asset register.
 *
 * Taking one back settles the clearance item in the same call — the custody
 * write is the register's own `return_asset`, not a second opinion about
 * custody kept here. The dependency runs one way: the register stays fully
 * usable in an org that never runs an exit checklist.
 */
function OutstandingAssets({
  detail,
  group,
  onError,
  onChanged,
}: {
  detail: ExitDetail
  group: ClearanceGroup
  onError: (msg: string | null) => void
  onChanged: () => void
}) {
  const held = useQuery<HeldAsset[]>(`offboarding-assets-${detail.id}`, () =>
    api.get<HeldAsset[]>(`/offboarding/requests/${detail.id}/assets`),
  )
  const [returning, setReturning] = useState<HeldAsset | null>(null)

  const openTasks = group.tasks.filter((t) => !t.is_settled)

  if (held.loading) {
    return (
      <div style={{ padding: '0 14px 12px' }}>
        <Loading label="Checking the register…" />
      </div>
    )
  }
  if (held.error) {
    return (
      <div style={{ padding: '0 14px 12px' }}>
        <ErrorNote>{errorText(held.error, 'Could not read the asset register')}</ErrorNote>
      </div>
    )
  }

  const rows = held.data ?? []

  return (
    <div style={{ padding: '0 14px 14px', borderTop: '1px solid var(--gridline)', paddingTop: 12 }}>
      <div className="ex-panel-head" style={{ marginBottom: 8 }}>
        <div>
          <h3 className="ex-panel-title">Still on the register under this name</h3>
          <p className="ex-panel-sub">
            Taking an asset back here closes the clearance item and the custody row in one go — no
            second trip to the Assets page.
          </p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="ex-clear">
          <IconCheck size={12} /> Nothing outstanding. The register shows no open custody for this
          person.
        </div>
      ) : (
        <div className="ex-assets">
          {rows.map((asset) =>
            returning?.id === asset.id ? (
              <ReturnAssetForm
                key={asset.id}
                requestId={detail.id}
                asset={asset}
                tasks={openTasks}
                onCancel={() => setReturning(null)}
                onDone={() => {
                  setReturning(null)
                  held.reload()
                  onChanged()
                }}
                onError={onError}
              />
            ) : (
              <div className="ex-asset" key={asset.id}>
                <div className="ex-asset-body">
                  <div className="ex-asset-tag">{asset.asset_tag}</div>
                  <div className="ex-asset-meta">
                    {ASSET_CATEGORY_LABEL[asset.category] ?? asset.category}
                    {asset.serial_number ? ` · ${asset.serial_number}` : ''}
                    {asset.assigned_at ? ` · issued ${dateTime(asset.assigned_at)}` : ''}
                  </div>
                </div>
                <button
                  className="btn btn-sm btn-primary"
                  disabled={openTasks.length === 0}
                  title={
                    openTasks.length === 0
                      ? 'Every IT clearance item is already settled — add one to record this return against it.'
                      : undefined
                  }
                  onClick={() => setReturning(asset)}
                >
                  <IconReturn size={13} /> Take it back
                </button>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  )
}

function ReturnAssetForm({
  requestId,
  asset,
  tasks,
  onCancel,
  onDone,
  onError,
}: {
  requestId: string
  asset: HeldAsset
  tasks: ExitTask[]
  onCancel: () => void
  onDone: () => void
  onError: (msg: string | null) => void
}) {
  const [taskId, setTaskId] = useState(tasks[0]?.id ?? '')
  const [note, setNote] = useState('')
  const [resulting, setResulting] = useState('available')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    onError(null)
    try {
      await api.post(`/offboarding/requests/${requestId}/tasks/${taskId}/return-asset`, {
        asset_id: asset.id,
        returned_at: null,
        returned_condition_note: note.trim() || null,
        resulting_status: resulting,
      })
      onDone()
    } catch (err) {
      onError(errorText(err, `Could not take ${asset.asset_tag} back`))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ex-panel" style={{ marginBottom: 0 }} onSubmit={submit}>
      <div className="ex-panel-head">
        <div>
          <h3 className="ex-panel-title">Take back {asset.asset_tag}</h3>
          <p className="ex-panel-sub">
            “Returned” and “available again” are not the same event. A laptop handed back with a
            cracked screen belongs in the repair queue, not on the next joiner's desk.
          </p>
        </div>
      </div>

      <div className="settings-grid">
        <label className="setting">
          Settles which clearance item
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)} required>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
        <label className="setting">
          Where it goes next
          <select value={resulting} onChange={(e) => setResulting(e.target.value)}>
            <option value="available">Back on the shelf — available</option>
            <option value="under_repair">Into the repair queue</option>
            <option value="retired">Written off</option>
          </select>
        </label>
        <label className="setting" style={{ gridColumn: '1 / -1' }}>
          Condition it came back in
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </label>
      </div>

      <div className="btn-group" style={{ marginTop: 12 }}>
        <button className="btn btn-sm btn-primary" disabled={busy || !taskId}>
          {busy ? 'Recording…' : 'Record the return'}
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/* ----------------------------------------------------------------- F&F --- */

/** A computed settlement, before anybody has agreed to it.
 *
 * The warnings sit above the figures, not below them, because every one of
 * them is a reason a number on this screen might be wrong — a missing notice
 * period, a leave type nobody marked encashable — and reading them after
 * approving is reading them too late. */
function ProposalReview({
  proposal,
  busy,
  onAccept,
  onDismiss,
}: {
  proposal: Proposal
  busy: boolean
  onAccept: () => void
  onDismiss: () => void
}) {
  return (
    <div className="ex-proposal">
      <div className="ex-panel-head">
        <div>
          <h4 className="ex-panel-title">Proposed settlement</h4>
          <p className="ex-panel-sub">
            Computed from data as it stands now, and saved nowhere until you accept it.
            Accepting recomputes — so a figure that moves in between is the current one, not
            this one.
          </p>
        </div>
        <div className="ex-panel-actions">
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={onAccept}>
            Accept and save
          </button>
          <button className="btn btn-sm" onClick={onDismiss}>Discard</button>
        </div>
      </div>

      {proposal.warnings.length > 0 && (
        <ul className="ex-warnings">
          {proposal.warnings.map((warning, i) => <li key={i}>{warning}</li>)}
        </ul>
      )}

      <FnfLines lines={proposal.lines} currency={proposal.currency} />

      <div className="ex-fnf-figures">
        <div className="ex-figure">
          <div className="ex-figure-label">Gross dues</div>
          <div className="ex-figure-value">
            {formatPaise(proposal.gross_dues_paise, proposal.currency)}
          </div>
        </div>
        <div className="ex-figure">
          <div className="ex-figure-label">Deductions</div>
          <div className="ex-figure-value">
            {formatPaise(proposal.deductions_paise, proposal.currency)}
          </div>
        </div>
        <div className="ex-figure">
          <div className="ex-figure-label">Net payable</div>
          <div className={`ex-figure-value ${
            proposal.net_payable_paise < 0 ? 'ex-figure-negative' : 'ex-figure-net'}`}>
            {formatPaise(proposal.net_payable_paise, proposal.currency)}
          </div>
          {proposal.net_payable_paise < 0 && (
            <div className="ex-hand-entered" style={{ marginTop: 4 }}>
              Negative — the leaver owes the company.
            </div>
          )}
        </div>
      </div>

      {proposal.tax_deducted_ytd > 0 && (
        <p className="ex-panel-sub">
          Tax context: {formatPaise(proposal.tax_paid_ytd, proposal.currency)} paid this
          financial year, {formatPaise(proposal.tax_deducted_ytd, proposal.currency)} deducted.
          Neither figure is applied above.
        </p>
      )}
    </div>
  )
}

/** The itemisation, shared by a proposal and a saved settlement.
 *
 * Amounts are stored positive with the side carried by `kind`, so the minus
 * sign is added here, at the one place a human reads it. */
function FnfLines({
  lines,
  currency,
}: {
  lines: Array<{ kind: string; code: string; label: string; amount_paise: number
                 detail: string | null }>
  currency: string
}) {
  return (
    <div className="table-wrap">
      <table className="table ex-fnf-lines">
        <tbody>
          {lines.map((line, i) => (
            <tr key={`${line.code}-${i}`}
                className={line.kind === 'deduction' ? 'is-deduction' : undefined}>
              <td>
                <div>{line.label}</div>
                {line.detail && <div className="ex-line-detail">{line.detail}</div>}
              </td>
              <td className="num">
                {line.kind === 'deduction' ? '−' : ''}
                {formatPaise(line.amount_paise, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The settlement.
 *
 * **Two ways in, and the panel keeps them apart.** "Compute" reads the salary
 * structure, leave balances, open loans and unpaid claims and proposes an
 * itemised settlement; "Record a settlement" takes three numbers on trust,
 * which is still the right route for a figure negotiated with the CFO. A
 * settlement carries `is_manually_entered` so a reader can always tell which
 * one produced it.
 *
 * A proposal is **not saved when it is shown.** Accepting recomputes it
 * server-side, because a proposal the browser has been holding since before a
 * claim was reimbursed is a proposal that is no longer true.
 *
 * `is_consistent` is the server saying gross − deductions ≠ net; that
 * is a warning and never an error, because ex-gratia payments and negotiated
 * write-offs make a mismatch legitimate often enough that refusing one would
 * block real settlements. This page therefore warns, and never quietly
 * corrects a figure somebody entered on purpose.
 *
 * Every edit writes an audit row server-side (D-018): the table has no
 * `updated_at`, so the audit trail is the only thing that says a number
 * changed.
 */
function FnfPanel({
  detail,
  onError,
  onChanged,
}: {
  detail: ExitDetail
  onError: (msg: string | null) => void
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [paying, setPaying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const fnf = detail.fnf

  /** Show what a settlement would be. Saves nothing — see the panel docblock. */
  async function compute() {
    setBusy(true)
    onError(null)
    try {
      setProposal(await api.get<Proposal>(
        `/offboarding/requests/${detail.id}/settlement/proposal`))
    } catch (err) {
      onError(errorText(err, 'Could not compute a settlement'))
    } finally {
      setBusy(false)
    }
  }

  /** Write it. The server recomputes rather than taking these figures back. */
  async function accept() {
    setBusy(true)
    onError(null)
    try {
      await api.post(`/offboarding/requests/${detail.id}/settlement/accept`, {})
      setProposal(null)
      onChanged()
    } catch (err) {
      onError(errorText(err, 'Could not save the settlement'))
    } finally {
      setBusy(false)
    }
  }

  async function approve() {
    if (!fnf) return
    setBusy(true)
    onError(null)
    try {
      await api.patch(`/offboarding/requests/${detail.id}/fnf`, { status: 'approved' })
      onChanged()
    } catch (err) {
      onError(errorText(err, 'Could not approve the settlement'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div className="ex-panel-head">
        <div>
          <h3 className="ex-panel-title">Full and final settlement</h3>
          <p className="ex-panel-sub">
            Compute one from payroll, leave, loans and unpaid claims — or record a figure worked
            out elsewhere. Either way the numbers are stored as they stand and never
            re-derived.
          </p>
        </div>
        <div className="ex-panel-actions">
          {(!fnf || fnf.status === 'draft') && (
            <button className="btn btn-sm btn-primary" disabled={busy}
                    onClick={() => void compute()}>
              {fnf ? 'Recompute' : 'Compute settlement'}
            </button>
          )}
          {!fnf && (
            <button className="btn btn-sm" onClick={() => setEditing(true)}>
              Record by hand
            </button>
          )}
        </div>
      </div>

      {proposal && (
        <ProposalReview
          proposal={proposal}
          busy={busy}
          onAccept={() => void accept()}
          onDismiss={() => setProposal(null)}
        />
      )}

      {!fnf ? (
        editing ? (
          <FnfForm
            detail={detail}
            fnf={null}
            onCancel={() => setEditing(false)}
            onDone={() => {
              setEditing(false)
              onChanged()
            }}
          />
        ) : (
          <Empty>
            No settlement recorded yet. That is different from a settlement of nothing — somebody
            chasing their money deserves the difference.
          </Empty>
        )
      ) : (
        <>
          <div className="ex-fnf-figures">
            <div className="ex-figure">
              <div className="ex-figure-label">Gross dues</div>
              <div className="ex-figure-value">
                {formatPaise(fnf.gross_dues_paise, fnf.currency)}
              </div>
            </div>
            <div className="ex-figure">
              <div className="ex-figure-label">Deductions</div>
              <div className="ex-figure-value">
                {formatPaise(fnf.deductions_paise, fnf.currency)}
              </div>
            </div>
            <div className="ex-figure">
              <div className="ex-figure-label">Net payable</div>
              <div
                className={`ex-figure-value ${fnf.net_payable_paise < 0 ? 'ex-figure-negative' : 'ex-figure-net'}`}
              >
                {formatPaise(fnf.net_payable_paise, fnf.currency)}
              </div>
              {fnf.net_payable_paise < 0 && (
                <div className="ex-hand-entered" style={{ marginTop: 4 }}>
                  Negative — the leaver owes the company.
                </div>
              )}
            </div>
          </div>

          {fnf.lines.length > 0 && (
            <FnfLines lines={fnf.lines} currency={fnf.currency} />
          )}

          {fnf.is_manually_entered && (
            <div className="ex-hand-entered" style={{ marginBottom: 12 }}>
              Entered by hand — there is no itemisation on file for this settlement.
            </div>
          )}

          {!fnf.is_consistent && (
            <div className="ex-note ex-note-warn" style={{ marginBottom: 12 }}>
              <b>Net does not equal gross minus deductions.</b> That is allowed — an ex-gratia
              payment or a negotiated write-off looks exactly like this — but nobody should save
              it by accident. Gross minus deductions would be{' '}
              <b>{formatPaise(fnf.gross_dues_paise - fnf.deductions_paise, fnf.currency)}</b>; the
              net on file is <b>{formatPaise(fnf.net_payable_paise, fnf.currency)}</b>. Nothing
              here will change either figure for you.
            </div>
          )}

          <div className="ex-fnf-status">
            <span className={`ex-pill ex-fnf-${fnf.status}`}>
              <span className="ex-pill-dot" style={{ background: 'currentColor' }} />
              {FNF_STATUS_LABEL[fnf.status] ?? fnf.status}
            </span>
            {fnf.status !== 'paid' && fnf.status !== 'cancelled' && (
              <>
                <button className="btn btn-sm" onClick={() => setEditing((v) => !v)}>
                  {editing ? 'Cancel edit' : 'Amend figures'}
                </button>
                {fnf.status === 'draft' && (
                  <button className="btn btn-sm" disabled={busy} onClick={() => void approve()}>
                    Approve
                  </button>
                )}
                <button className="btn btn-sm btn-primary" onClick={() => setPaying((v) => !v)}>
                  {paying ? 'Cancel' : 'Mark paid'}
                </button>
              </>
            )}
            {fnf.status === 'paid' && (
              <button className="btn btn-sm" onClick={() => setEditing((v) => !v)}>
                {editing ? 'Cancel edit' : 'Amend after payment'}
              </button>
            )}
          </div>

          {fnf.status === 'paid' && editing && (
            <div className="ex-note ex-note-warn" style={{ marginBottom: 12 }}>
              <b>This settlement has already been paid.</b> An amendment is recorded under its own
              audit action so it can be found later — this table has no “last modified” column and
              the audit trail is the only thing that will say the number changed.
            </div>
          )}

          {editing && (
            <FnfForm
              detail={detail}
              fnf={fnf}
              onCancel={() => setEditing(false)}
              onDone={() => {
                setEditing(false)
                onChanged()
              }}
            />
          )}

          {paying && (
            <MarkPaidForm
              detail={detail}
              onCancel={() => setPaying(false)}
              onDone={() => {
                setPaying(false)
                onChanged()
              }}
            />
          )}

          <div className="ex-record" style={{ marginTop: 12 }}>
            <div className="ex-record-row">
              <span>Prepared by</span>
              <b>{fnf.prepared_by_name ?? '—'}</b>
            </div>
            <div className="ex-record-row">
              <span>Approved by</span>
              <b>
                {fnf.approved_by_name ?? '—'}
                {fnf.approved_at ? ` · ${dateTime(fnf.approved_at)}` : ''}
              </b>
            </div>
            <div className="ex-record-row">
              <span>Paid</span>
              <b>
                {fnf.paid_on ? shortDate(fnf.paid_on) : '—'}
                {fnf.paid_by_name ? ` · ${fnf.paid_by_name}` : ''}
              </b>
            </div>
            <div className="ex-record-row">
              <span>Reference</span>
              <b>{fnf.payment_reference ?? '—'}</b>
            </div>
          </div>

          {fnf.notes && (
            <div className="ex-task-note" style={{ marginTop: 10 }}>
              <span className="ex-task-note-label">Notes</span>
              {fnf.notes}
            </div>
          )}

          <div className="ex-hand-entered" style={{ marginTop: 10 }}>
            Entered by hand — no system calculated these figures.
          </div>
        </>
      )}
    </div>
  )
}

function FnfForm({
  detail,
  fnf,
  onCancel,
  onDone,
}: {
  detail: ExitDetail
  fnf: Fnf | null
  onCancel: () => void
  onDone: () => void
}) {
  const [gross, setGross] = useState(fnf ? paiseToInput(fnf.gross_dues_paise) : '')
  const [deductions, setDeductions] = useState(fnf ? paiseToInput(fnf.deductions_paise) : '')
  const [net, setNet] = useState(fnf ? paiseToInput(fnf.net_payable_paise) : '')
  const [currency, setCurrency] = useState(fnf?.currency ?? 'INR')
  const [notes, setNotes] = useState(fnf?.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const grossP = parseRupees(gross)
  const dedP = parseRupees(deductions)
  const netP = parseRupees(net)
  const parseable = grossP !== null && dedP !== null && netP !== null
  /* Integer arithmetic only, on the same figures the server will compare. */
  const mismatch = parseable && grossP - dedP !== netP

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!parseable) {
      setError('Those are not amounts. Use digits and at most two decimal places.')
      return
    }
    setBusy(true)
    setError(null)
    const body = {
      gross_dues_paise: grossP,
      deductions_paise: dedP,
      net_payable_paise: netP,
      currency,
      notes: notes.trim() || null,
    }
    try {
      if (fnf) await api.patch(`/offboarding/requests/${detail.id}/fnf`, body)
      else await api.post(`/offboarding/requests/${detail.id}/fnf`, body)
      onDone()
    } catch (err) {
      setError(errorText(err, 'Could not save the settlement'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ex-panel" onSubmit={submit}>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="settings-grid">
        <label className="setting">
          Gross dues
          <input
            className="ex-money-input"
            inputMode="decimal"
            value={gross}
            onChange={(e) => setGross(e.target.value)}
            placeholder="0.00"
            autoFocus
          />
          <span className="setting-hint">Salary, leave encashment, bonus — in whole rupees and paise.</span>
        </label>
        <label className="setting">
          Deductions
          <input
            className="ex-money-input"
            inputMode="decimal"
            value={deductions}
            onChange={(e) => setDeductions(e.target.value)}
            placeholder="0.00"
          />
          <span className="setting-hint">Notice shortfall, advances, anything recovered.</span>
        </label>
        <label className="setting">
          Net payable
          <input
            className="ex-money-input"
            inputMode="decimal"
            value={net}
            onChange={(e) => setNet(e.target.value)}
            placeholder="0.00"
          />
          <span className="setting-hint">
            Typed, never derived. It may be negative if the leaver owes the company, and it is
            allowed to differ from gross minus deductions.
          </span>
        </label>
        <label className="setting">
          Currency
          <input
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
            maxLength={3}
          />
        </label>
        <label className="setting" style={{ gridColumn: '1 / -1' }}>
          Notes
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Where these figures came from, and anything negotiated."
          />
        </label>
      </div>

      {mismatch && parseable && (
        <div className="ex-note ex-note-warn" style={{ marginTop: 12 }}>
          <b>Heads up:</b> gross minus deductions is{' '}
          {formatPaise(grossP - dedP, currency)}, and you have entered a net of{' '}
          {formatPaise(netP, currency)}. That is a legitimate settlement if it is deliberate —
          this will save exactly what you typed, and nothing will be corrected for you.
        </div>
      )}

      <div className="btn-group" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : fnf ? 'Save the settlement' : 'Record the settlement'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** Paid needs both a date and a reference: the server refuses one without the
 *  other, and a settlement that cannot be evidenced later is the one thing this
 *  record exists to prevent. */
function MarkPaidForm({
  detail,
  onCancel,
  onDone,
}: {
  detail: ExitDetail
  onCancel: () => void
  onDone: () => void
}) {
  const [paidOn, setPaidOn] = useState('')
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.patch(`/offboarding/requests/${detail.id}/fnf`, {
        status: 'paid',
        paid_on: paidOn,
        payment_reference: reference.trim(),
      })
      onDone()
    } catch (err) {
      setError(errorText(err, 'Could not mark the settlement paid'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ex-panel" onSubmit={submit}>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <div className="settings-grid">
        <label className="setting">
          Paid on
          <input
            type="date"
            value={paidOn}
            onChange={(e) => setPaidOn(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label className="setting">
          Payment reference
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="NEFT/UTR or cheque number"
            required
          />
          <span className="setting-hint">
            Both are required. Being able to evidence the payment later is the only reason this
            record exists.
          </span>
        </label>
      </div>
      <div className="btn-group" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" disabled={busy || !paidOn || !reference.trim()}>
          {busy ? 'Saving…' : 'Mark it paid'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
