/* My Support Center — find the customer, see everything, log the call.
 *
 * The one screen in this module that is a *desk* rather than a list, and the
 * shape is the whole point: a support call lasts ninety seconds, and anything
 * that makes the person navigate during it — a link to a customer page, a
 * separate "log a call" form — means the call ends before the record does.
 * So the layout is fixed: search at the top loads a customer into the panels
 * below, and the log form on the right stays put through all of it. The page
 * never navigates.
 *
 * Everything about a customer that a caller might be asked is on the left:
 * what they bought, when it renews, which visits are booked, what could be sold
 * to them next. The history underneath is every call this desk has had with
 * them, so "I rang last Tuesday and someone said…" is answerable.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import '../../styles/crm.css'
import { useQuery } from '../../lib/useQuery'
import { dateTime } from '../../lib/format'
import { ErrorNote, Loading } from '../../components/ui'
import {
  IconCalendar,
  IconCheck,
  IconMail,
  IconPhone,
  IconPin,
  IconSearch,
  IconUsers,
} from '../../components/Icons'
import {
  crm,
  crmError,
  inDays,
  type Customer,
  type CustomerDetail,
  type Disposition,
  type Interaction,
} from './api'
import { Assignee, CustomerPicker, DuePill, Field, StateText, WhatsAppButton } from './parts'

export default function SupportCenter() {
  const [picked, setPicked] = useState<Customer | null>(null)

  const detail = useQuery<CustomerDetail | null>(
    `crm-support-${picked?.id ?? 'none'}`,
    () => (picked ? crm.customer(picked.id) : Promise.resolve(null)),
    { enabled: Boolean(picked) },
  )
  const summary = useQuery('crm-support-summary', () => crm.supportSummary())

  const customer = detail.data ?? null

  /* The period the counts and the history cover. Picked in the select and
     applied with Set, so stepping through the options does not refetch. */
  const [periodDraft, setPeriodDraft] = useState<Period>('today')
  const [period, setPeriod] = useState<Period>('today')
  const recent = useQuery<Interaction[]>('crm-support-recent', () => crm.interactions({ limit: 500 }))
  const inPeriod = (recent.data ?? []).filter((row) => withinPeriod(row.created_at, period))
  const counts = {
    logged: inPeriod.length,
    open: inPeriod.filter((row) => row.status === 'open').length,
    closed: inPeriod.filter((row) => row.status === 'closed').length,
  }

  async function openCustomer(customerId: string) {
    try {
      const full = await crm.customer(customerId)
      setPicked(full)
    } catch {
      /* Left where it was; the desk only changes on success. */
    }
  }

  return (
    /* No page heading: "My Support Desk" is the tab above. One bar on top —
       find the caller, the period, the counts — then the customer and the
       log form side by side, and the call history across the bottom. */
    <div className="crm sd-page">
      <div className="card sd-bar">
        <div className="sd-bar-search">
          <IconSearch size={16} />
          <CustomerPicker
            value={picked}
            onPick={(next) => {
              setPicked(next)
            }}
            placeholder="Search Customer ID, mobile number or email…"
            autoFocus
          />
        </div>
        <div className="sd-bar-period">
          <select value={periodDraft} onChange={(e) => setPeriodDraft(e.target.value as Period)} aria-label="Period">
            {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          <button type="button" className="btn sd-bar-set" onClick={() => setPeriod(periodDraft)}
                  disabled={periodDraft === period}>
            Set
          </button>
        </div>
        <div className="sd-bar-counts" aria-label="Calls in this period">
          <span>Logged {PERIODS.find((p) => p.key === period)?.short} <strong>{counts.logged}</strong></span>
          <span>Open <strong className="is-open">{counts.open}</strong></span>
          <span>Closed <strong className="is-closed">{counts.closed}</strong></span>
        </div>
      </div>

      <div className="crm-desk">
        <div className="sd-main">
          {picked && !customer && detail.error ? (
            <ErrorNote>{crmError(detail.cause, 'That customer could not be loaded')}</ErrorNote>
          ) : picked && !customer ? (
            <section className="card"><Loading label="Loading the customer…" /></section>
          ) : customer ? (
            <Profile customer={customer} onClear={() => setPicked(null)} />
          ) : (
            <EmptyProfile />
          )}

        </div>

        <LogPanel
          customer={customer}
          onLogged={() => {
            detail.reload()
            summary.reload()
            recent.reload()
          }}
        />
      </div>

      <HistoryTable
        rows={customer ? customer.interactions : inPeriod}
        loading={!customer && recent.loading && !recent.data}
        scope={customer ? `${customer.name}` : PERIODS.find((p) => p.key === period)?.label ?? ''}
        showCustomer={!customer}
        onOpen={openCustomer}
      />
    </div>
  )
}

/* ------------------------------------------------------------ period --- */

type Period = 'today' | '7d' | '30d' | 'all'
const PERIODS: Array<{ key: Period; label: string; short: string }> = [
  { key: 'today', label: 'Logged today', short: 'today' },
  { key: '7d', label: 'Last 7 days', short: '· 7 days' },
  { key: '30d', label: 'Last 30 days', short: '· 30 days' },
  { key: 'all', label: 'All time', short: '' },
]

function withinPeriod(iso: string, period: Period): boolean {
  if (period === 'all') return true
  const when = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`)
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  if (period === '7d') start.setDate(start.getDate() - 6)
  if (period === '30d') start.setDate(start.getDate() - 29)
  return when >= start
}

/* ------------------------------------------------------- empty states --- */

/** The profile card before anybody is searched — the same shape, dashed out,
 *  so the desk never jumps when a customer loads into it. */
function EmptyProfile() {
  return (
    <section className="card sd-profile is-empty">
      <div className="sd-profile-head">
        <span className="sd-avatar" aria-hidden>—</span>
        <div className="sd-profile-name">
          <h2>No customer selected</h2>
          <span className="crm-sub">Search above to load a customer</span>
        </div>
      </div>
      <div className="sd-facts">
        <Fact icon={<IconPhone size={14} />} label="Mobile" value={null} />
        <Fact icon={<IconMail size={14} />} label="Email" value={null} />
        <Fact icon={<IconUsers size={14} />} label="Account manager" value={null} />
        <Fact icon={<IconPin size={14} />} label="Location" value={null} />
      </div>
    </section>
  )
}

/* ------------------------------------------------------------ history --- */

/** The call history across the bottom: every call in the period before a
 *  customer is chosen, that customer's calls once one is. */
function HistoryTable({ rows, loading, scope, showCustomer, onOpen }: {
  rows: Interaction[]
  loading: boolean
  scope: string
  showCustomer: boolean
  onOpen: (customerId: string) => void
}) {
  const cols = showCustomer ? 9 : 8
  return (
    <section className="card sd-panel sd-history-card">
      <div className="sd-panel-head">
        <h2>Last Support History</h2>
        <span className="crm-sub">{scope} · {rows.length} call{rows.length === 1 ? '' : 's'}</span>
      </div>
      <div className="table-wrap sd-history-wrap">
        <table className="sd-table sd-history-table">
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Date &amp; time</th>
              {showCustomer && <th>Customer</th>}
              <th>Type</th>
              <th>Disposition</th>
              <th>Status</th>
              <th>Remarks</th>
              <th>Staff</th>
              <th>Follow-up</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={cols} className="sd-empty-cell">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={cols} className="sd-empty-cell">No support calls in this period.</td></tr>
            ) : rows.map((row) => (
              <tr key={row.id}>
                <td className="crm-code">{row.ticket_no}</td>
                <td className="crm-nowrap">{dateTime(row.created_at)}</td>
                {showCustomer && (
                  <td>
                    <button type="button" className="sd-recent-customer" onClick={() => onOpen(row.customer_id)}
                            title="Open this customer on the desk">
                      {row.customer_name ?? 'Customer'}
                    </button>
                  </td>
                )}
                <td>
                  <span className={`sd-dir is-${row.direction}`}>
                    {row.direction === 'inbound' ? '↓ Inbound' : '↑ Outbound'}
                  </span>
                </td>
                <td>{row.disposition_name ?? <span className="crm-muted">—</span>}</td>
                <td><StateText value={row.status} /></td>
                <td className="sd-remarks" title={row.remarks ?? undefined}>
                  {row.remarks ?? <span className="crm-muted">—</span>}
                </td>
                <td className="crm-nowrap">{row.staff_name ?? <span className="crm-muted">—</span>}</td>
                <td className="crm-nowrap">
                  {row.follow_up_due_at ? <DuePill iso={row.follow_up_due_at} /> : <span className="crm-muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** The loaded customer: who they are, how to reach them, and the three facts a
 *  caller asks about first — what is active, when it renews, what is open. */
function Profile({ customer, onClear }: { customer: CustomerDetail; onClear: () => void }) {
  const initials = customer.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('')
  const active = customer.plans.filter((plan) => plan.status === 'active').length
  const next = customer.plans
    .filter((plan) => plan.renewal_on && plan.days_to_renewal !== null)
    .sort((a, b) => (a.days_to_renewal ?? 0) - (b.days_to_renewal ?? 0))[0]
  const open = customer.interactions.filter((row) => row.status === 'open').length

  return (
    <section className="card sd-profile">
      <div className="sd-profile-head">
        <span className="sd-avatar" aria-hidden>{initials}</span>
        <div className="sd-profile-name">
          <h2>{customer.name}</h2>
          <span className="crm-sub">
            <span className="crm-code">{customer.code}</span>
            {customer.company ? ` · ${customer.company}` : ''}
          </span>
        </div>
        <div className="sd-profile-actions">
          <StateText value={customer.status} />
          <WhatsAppButton mobile={customer.whatsapp ?? customer.mobile} />
          <Link className="btn btn-sm" to={`/crm/customers?open=${customer.id}`}>Full record</Link>
          <button type="button" className="sd-clear" onClick={onClear}
                  title="Clear — back to all calls" aria-label="Clear the customer">×</button>
        </div>
      </div>

      <div className="sd-facts">
        <Fact icon={<IconPhone size={14} />} label="Mobile" value={customer.mobile} />
        <Fact icon={<IconMail size={14} />} label="Email" value={customer.email && <span title={customer.email}>{customer.email}</span>} />
        <Fact icon={<IconUsers size={14} />} label="Account manager"
              value={customer.manager_name && <Assignee name={customer.manager_name} />} />
        <Fact icon={<IconPin size={14} />} label="Location"
              value={[customer.city_name, customer.state_name].filter(Boolean).join(', ')} />
      </div>

      <div className="sd-quick">
        <div className="sd-quick-item">
          <span className="sd-quick-label">Active plans</span>
          <span className="sd-quick-value">{active}</span>
        </div>
        <div className={`sd-quick-item${next && (next.days_to_renewal ?? 0) < 0 ? ' is-late' : ''}`}>
          <span className="sd-quick-label"><IconCalendar size={13} /> Next renewal</span>
          <span className="sd-quick-value">
            {next ? <>{next.renewal_on}<small>{inDays(next.days_to_renewal)}</small></> : '—'}
          </span>
        </div>
        <div className={`sd-quick-item${open > 0 ? ' is-warn' : ''}`}>
          <span className="sd-quick-label">Open tickets</span>
          <span className="sd-quick-value">{open}</span>
        </div>
      </div>
    </section>
  )
}

function Fact({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="sd-fact">
      <span className="sd-fact-label">{icon}{label}</span>
      <span className="sd-fact-value">{value || <span className="crm-muted">—</span>}</span>
    </div>
  )
}

/** The log form. Stays on screen whether or not a customer is loaded, so the
 *  person on the phone can see where the call is going to be written before
 *  they have finished finding who is calling. */
function LogPanel({
  customer,
  onLogged,
}: {
  customer: CustomerDetail | null
  onLogged: () => void
}) {
  const [direction, setDirection] = useState<'inbound' | 'outbound'>('inbound')
  const [dispositionId, setDispositionId] = useState('')
  const [status, setStatus] = useState<'open' | 'closed'>('open')
  const [remarks, setRemarks] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const dispositions = useQuery<Disposition[]>('crm-dispositions', () =>
    crm.masters<Disposition>('dispositions'),
  )

  // A disposition that means "done" pre-selects Closed. It is a default and not
  // a lock — the desk can still say the call is open.
  useEffect(() => {
    const picked = (dispositions.data ?? []).find((row) => row.id === dispositionId)
    if (picked?.closes_interaction) setStatus('closed')
  }, [dispositionId, dispositions.data])

  async function save() {
    if (!customer) return
    setBusy(true)
    setError(null)
    try {
      const logged = await crm.logInteraction({
        customer_id: customer.id,
        direction,
        disposition_id: dispositionId || null,
        status,
        remarks: remarks || null,
      })
      setSaved(logged.ticket_no)
      setRemarks('')
      onLogged()
    } catch (err) {
      setError(crmError(err, 'That call could not be logged'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card sd-log">
      <div className="sd-log-head">
        <span className="sd-log-icon" aria-hidden><IconPhone size={16} /></span>
        <div>
          <h2>Log interaction</h2>
          <span className="crm-sub">
            {customer ? <>For <b>{customer.name}</b></> : 'Load a customer to log the call'}
          </span>
        </div>
      </div>
      <div className="sd-log-body">
        {error && <ErrorNote>{error}</ErrorNote>}
        {saved && (
          <div className="sd-saved">
            <IconCheck size={15} />
            <span>Logged as <b>{saved}</b></span>
            <button className="link-btn" onClick={() => setSaved(null)}>Dismiss</button>
          </div>
        )}

        <div className="sd-log-row">
          <span className="crm-field-label">Interaction type</span>
          <div className="sd-choice" role="radiogroup" aria-label="Interaction type">
            <button type="button" role="radio" aria-checked={direction === 'inbound'}
                    className={direction === 'inbound' ? 'is-on' : ''} onClick={() => setDirection('inbound')}>
              ↓ Inbound
            </button>
            <button type="button" role="radio" aria-checked={direction === 'outbound'}
                    className={direction === 'outbound' ? 'is-on' : ''} onClick={() => setDirection('outbound')}>
              ↑ Outbound
            </button>
          </div>
        </div>

        <div className="sd-grid-2">
          <Field label="Disposition">
            <select value={dispositionId} onChange={(event) => setDispositionId(event.target.value)}>
              <option value="">Select…</option>
              {(dispositions.data ?? [])
                .filter((row) => row.is_active)
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Status">
            <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
          </Field>
        </div>

        <Field label="Remarks / notes">
          <textarea
            value={remarks}
            onChange={(event) => setRemarks(event.target.value)}
            rows={5}
            placeholder={customer ? 'What was said? What was promised?' : 'Search a customer first'}
            disabled={!customer}
          />
        </Field>

        <button
          className="btn btn-primary sd-log-save"
          onClick={save}
          disabled={!customer || busy}
          title={customer ? undefined : 'Load a customer first'}
        >
          {busy ? 'Saving…' : 'Save interaction'}
        </button>
      </div>
    </section>
  )
}
