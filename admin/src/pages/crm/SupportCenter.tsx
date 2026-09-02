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

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import '../../styles/crm.css'
import { useQuery } from '../../lib/useQuery'
import { dateTime } from '../../lib/format'
import { ErrorNote, Loading } from '../../components/ui'
import { IconInfo, IconLifebuoy, IconStar } from '../../components/Icons'
import {
  crm,
  crmError,
  inDays,
  isoToLocalInput,
  localToISO,
  rupees,
  type Customer,
  type CustomerDetail,
  type Disposition,
} from './api'
import { CrmPage, CustomerPicker, DueDate, Field, StateText, WhatsAppButton } from './parts'

type Tab = 'plans' | 'visits' | 'cross-sell'

export default function SupportCenter() {
  const [picked, setPicked] = useState<Customer | null>(null)
  const [tab, setTab] = useState<Tab>('plans')

  const detail = useQuery<CustomerDetail | null>(
    `crm-support-${picked?.id ?? 'none'}`,
    () => (picked ? crm.customer(picked.id) : Promise.resolve(null)),
    { enabled: Boolean(picked) },
  )
  const summary = useQuery('crm-support-summary', () => crm.supportSummary())

  const customer = detail.data ?? null

  return (
    <CrmPage
      title="My Support Center"
      subtitle="Find the customer, see everything, log the call — without leaving the page"
    >
      <section className="card" style={{ padding: 14, marginBottom: 16 }}>
        <div className="crm-bar" style={{ marginBottom: 0 }}>
          <div style={{ flex: '1 1 340px', minWidth: 240 }}>
            <CustomerPicker
              value={picked}
              onPick={(next) => {
                setPicked(next)
                setTab('plans')
              }}
              placeholder="Search Customer ID, mobile number or email…"
              autoFocus
            />
          </div>
          <div className="crm-push crm-sub" style={{ display: 'flex', gap: 16 }}>
            <span>
              Logged today <strong>{summary.data?.logged_today ?? 0}</strong>
            </span>
            <span>
              Open <strong>{summary.data?.open ?? 0}</strong>
            </span>
            <span>
              Closed <strong>{summary.data?.closed ?? 0}</strong>
            </span>
          </div>
        </div>
      </section>

      <div className="crm-desk">
        <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
          <section className="card">
            <div className="crm-ident">
              <div style={{ minWidth: 0 }}>
                <div className={customer ? 'crm-ident-name' : 'crm-ident-name crm-muted'}>
                  {customer ? customer.name : 'No customer selected'}
                </div>
                <div className="crm-sub">
                  {customer
                    ? `${customer.code}${customer.company ? ` · ${customer.company}` : ''}`
                    : 'Search above to load a customer'}
                </div>
              </div>
              <div className="crm-ident-actions">
                {customer && <StateText value={customer.status} />}
                <WhatsAppButton mobile={customer?.whatsapp ?? customer?.mobile ?? null} />
                {customer && (
                  <Link className="btn btn-sm" to={`/crm/customers?open=${customer.id}`}>
                    Full record
                  </Link>
                )}
              </div>
            </div>
            <div className="crm-facts">
              <div>
                <div className="crm-fact-label">Mobile</div>
                <div className="crm-fact-value">{customer?.mobile ?? '—'}</div>
              </div>
              <div>
                <div className="crm-fact-label">Email</div>
                <div className="crm-fact-value">{customer?.email ?? '—'}</div>
              </div>
              <div>
                <div className="crm-fact-label">Account manager</div>
                <div className="crm-fact-value">{customer?.manager_name ?? '—'}</div>
              </div>
              <div>
                <div className="crm-fact-label">Location</div>
                <div className="crm-fact-value">
                  {[customer?.city_name, customer?.state_name].filter(Boolean).join(', ') || '—'}
                </div>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="crm-tabs" style={{ padding: 14, marginBottom: 0 }}>
              <button
                className={`crm-tab${tab === 'plans' ? ' crm-tab-on' : ''}`}
                onClick={() => setTab('plans')}
              >
                <IconStar size={14} /> Plans
              </button>
              <button
                className={`crm-tab${tab === 'visits' ? ' crm-tab-on' : ''}`}
                onClick={() => setTab('visits')}
              >
                <IconInfo size={14} /> Visits
              </button>
              <button
                className={`crm-tab${tab === 'cross-sell' ? ' crm-tab-on' : ''}`}
                onClick={() => setTab('cross-sell')}
              >
                <IconLifebuoy size={14} /> Cross-Sell
              </button>
            </div>

            {!customer ? (
              <p className="empty">
                {tab === 'plans'
                  ? 'Search a customer to see their plans and renewal dates.'
                  : tab === 'visits'
                    ? 'Search a customer to see the field calls booked with them.'
                    : 'Search a customer to see what they have not bought yet.'}
              </p>
            ) : tab === 'plans' ? (
              <PlansTable customer={customer} />
            ) : tab === 'visits' ? (
              <VisitsTable customer={customer} />
            ) : (
              <CrossSell customer={customer} />
            )}
          </section>

          <section className="card">
            <div className="crm-panel-head">
              <h2 className="crm-panel-title">Last Support History</h2>
            </div>
            {!customer ? (
              <p className="empty">Search a customer to see every call the desk has had with them.</p>
            ) : customer.interactions.length === 0 ? (
              <p className="empty">Nobody has logged a call with this customer yet.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Ticket</th>
                      <th>Date &amp; time</th>
                      <th>Type</th>
                      <th>Disposition</th>
                      <th>Status</th>
                      <th>Remarks</th>
                      <th>Staff</th>
                      <th>Follow-up</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customer.interactions.map((row) => (
                      <tr key={row.id}>
                        <td className="crm-code">{row.ticket_no}</td>
                        <td className="crm-nowrap">{dateTime(row.created_at)}</td>
                        <td>{row.direction === 'inbound' ? 'Inbound' : 'Outbound'}</td>
                        <td>{row.disposition_name ?? <span className="crm-muted">—</span>}</td>
                        <td>
                          <StateText value={row.status} />
                        </td>
                        <td>{row.remarks ?? <span className="crm-muted">—</span>}</td>
                        <td>{row.staff_name ?? <span className="crm-muted">—</span>}</td>
                        <td className="crm-nowrap">
                          <DueDate iso={row.follow_up_due_at} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <LogPanel
          customer={customer}
          onLogged={() => {
            detail.reload()
            summary.reload()
          }}
        />
      </div>
    </CrmPage>
  )
}

function PlansTable({ customer }: { customer: CustomerDetail }) {
  if (customer.plans.length === 0) {
    return <p className="empty">This customer has no plans recorded. Add one on their record.</p>
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Product / Service</th>
            <th>Plan</th>
            <th>Start</th>
            <th>End</th>
            <th>Renewal</th>
            <th className="crm-num">Payment</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {customer.plans.map((plan) => (
            <tr key={plan.id}>
              <td className="crm-strong">{plan.product_name}</td>
              <td>{plan.plan_name ?? <span className="crm-muted">—</span>}</td>
              <td className="crm-nowrap">{plan.start_on}</td>
              <td className="crm-nowrap">{plan.end_on ?? '—'}</td>
              <td className="crm-nowrap">
                {plan.renewal_on ?? '—'}
                <div
                  className={
                    plan.days_to_renewal !== null && plan.days_to_renewal < 0
                      ? 'crm-due-over'
                      : 'crm-sub'
                  }
                >
                  {inDays(plan.days_to_renewal)}
                </div>
              </td>
              <td className="crm-num">
                {rupees(plan.amount)}
                <div className="crm-sub">
                  <StateText value={plan.payment_status} />
                </div>
              </td>
              <td>
                <StateText value={plan.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function VisitsTable({ customer }: { customer: CustomerDetail }) {
  if (customer.visits.length === 0) {
    return <p className="empty">No field calls booked with this customer.</p>
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Visit no</th>
            <th>Type</th>
            <th>Scheduled</th>
            <th>Employee</th>
            <th>Status</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {customer.visits.map((visit) => (
            <tr key={visit.id}>
              <td className="crm-code">{visit.visit_no}</td>
              <td>{visit.visit_type_name ?? '—'}</td>
              <td className="crm-nowrap">{dateTime(visit.scheduled_at)}</td>
              <td>{visit.employee_name ?? <span className="crm-muted">Unassigned</span>}</td>
              <td>
                <StateText value={visit.status} />
              </td>
              <td>{visit.outcome ?? <span className="crm-muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** What this customer has not bought.
 *
 * Derived in the browser from two lists the page already has rather than a
 * server endpoint of its own: it is a set difference over a catalogue of a few
 * dozen products, and a "recommendations" API would be a new thing to maintain
 * that answered exactly this question. */
function CrossSell({ customer }: { customer: CustomerDetail }) {
  const products = useQuery('crm-products-all', () => crm.masters('products'))
  const owned = useMemo(
    () => new Set(customer.plans.map((plan) => plan.product_id).filter(Boolean) as string[]),
    [customer.plans],
  )
  const rest = (products.data ?? []).filter((product) => product.is_active && !owned.has(product.id))

  if (products.loading) return <Loading />
  if (rest.length === 0) {
    return <p className="empty">This customer already has everything on the catalogue.</p>
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Product / Service</th>
            <th className="crm-num">List rate</th>
            <th style={{ textAlign: 'right' }}>Offer it</th>
          </tr>
        </thead>
        <tbody>
          {rest.map((product) => (
            <tr key={product.id}>
              <td className="crm-strong">{product.name}</td>
              <td className="crm-num">{rupees((product as { rate?: string }).rate ?? '0')}</td>
              <td>
                <div className="crm-row-actions">
                  <Link className="btn btn-sm" to={`/crm/quotations/new?customer=${customer.id}`}>
                    Quote it
                  </Link>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
  const [bookFollowUp, setBookFollowUp] = useState(false)
  const [followUpAt, setFollowUpAt] = useState(() => {
    const soon = new Date()
    soon.setDate(soon.getDate() + 1)
    soon.setHours(10, 0, 0, 0)
    return isoToLocalInput(soon.toISOString())
  })
  const [followUpPurpose, setFollowUpPurpose] = useState('')
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
        follow_up_at: bookFollowUp ? localToISO(followUpAt) : null,
        follow_up_purpose: bookFollowUp ? followUpPurpose || null : null,
      })
      setSaved(logged.ticket_no)
      setRemarks('')
      setBookFollowUp(false)
      setFollowUpPurpose('')
      onLogged()
    } catch (err) {
      setError(crmError(err, 'That call could not be logged'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card" style={{ alignSelf: 'start', position: 'sticky', top: 12 }}>
      <div className="crm-panel-head">
        <h2 className="crm-panel-title">Log Interaction</h2>
      </div>
      <div className="crm-log">
        {error && <ErrorNote>{error}</ErrorNote>}
        {saved && (
          <div className="notice notice-ok">
            Logged as {saved}.{' '}
            <button className="link-btn" onClick={() => setSaved(null)}>
              Dismiss
            </button>
          </div>
        )}

        <div className="crm-log-row">
          <span className="crm-log-label">Interaction type</span>
          <div className="crm-choice">
            <button
              className={direction === 'inbound' ? 'crm-choice-on' : ''}
              onClick={() => setDirection('inbound')}
            >
              Inbound
            </button>
            <button
              className={direction === 'outbound' ? 'crm-choice-on' : ''}
              onClick={() => setDirection('outbound')}
            >
              Outbound
            </button>
          </div>
        </div>

        <div className="crm-grid-2">
          <Field label="Disposition">
            <select
              value={dispositionId}
              onChange={(event) => setDispositionId(event.target.value)}
            >
              <option value="">—</option>
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
            placeholder={customer ? 'What was said?' : 'Search a customer first'}
            disabled={!customer}
          />
        </Field>

        <div className="card" style={{ padding: 12 }}>
          <label className="crm-check">
            <input
              type="checkbox"
              checked={bookFollowUp}
              onChange={(event) => setBookFollowUp(event.target.checked)}
              disabled={!customer}
            />
            <span>
              <strong>Book a follow-up</strong>
              <div className="crm-sub">
                Lands in My Follow-ups with everything else that is owed.
              </div>
            </span>
          </label>
          {bookFollowUp && (
            <div className="crm-grid-2" style={{ marginTop: 10 }}>
              <Field label="When">
                <input
                  type="datetime-local"
                  value={followUpAt}
                  onChange={(event) => setFollowUpAt(event.target.value)}
                />
              </Field>
              <Field label="Purpose">
                <input
                  value={followUpPurpose}
                  onChange={(event) => setFollowUpPurpose(event.target.value)}
                  placeholder="Call back about the renewal"
                />
              </Field>
            </div>
          )}
        </div>

        <button
          className="btn btn-primary"
          onClick={save}
          disabled={!customer || busy}
          title={customer ? undefined : 'Load a customer first'}
        >
          {busy ? 'Saving…' : 'Save Interaction'}
        </button>
      </div>
    </section>
  )
}
