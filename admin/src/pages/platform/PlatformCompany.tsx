import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ErrorNote } from '../../components/ui'
import {
  bytes,
  platformApi,
  rupees,
  type CompanyDetail,
  type CompanyUpdate,
  type PlanRow,
  type PlatformEmployee,
  type SubscriptionOverride,
} from '../../lib/platformApi'
import CompanyDelete from './CompanyDelete'
import CompanyModules from './CompanyModules'
import CompanyEdit from './CompanyEdit'
import { StatusPill } from './PlatformCompanies'

export default function PlatformCompany() {
  const { orgId = '' } = useParams()
  const navigate = useNavigate()
  const [company, setCompany] = useState<CompanyDetail | null>(null)
  const [employees, setEmployees] = useState<PlatformEmployee[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    try {
      setCompany(await platformApi.company(orgId))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the company')
    }
  }, [orgId])

  useEffect(() => {
    void load()
    platformApi.employees(orgId).then(setEmployees).catch(() => setEmployees([]))
  }, [orgId, load])

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      await load()
      setNotice(message)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  async function suspend() {
    const reason = window.prompt(
      'Why is this company being suspended?\n\n' +
        'This stops the dashboard AND deactivates every agent, so collection stops too.',
    )
    if (!reason?.trim()) return
    await run(() => platformApi.suspend(orgId, reason.trim()), 'Company suspended.')
  }

  async function saveCompany(body: CompanyUpdate) {
    const saved = await platformApi.updateCompany(orgId, body)
    setEditing(false)
    await load()
    setError(null)
    setNotice(
      body.slug
        ? `Saved. The workspace is now ${saved.slug} — everyone signs in at the new address.`
        : 'Company details saved.',
    )
  }

  async function destroy(confirmSlug: string, reason: string) {
    const result = await platformApi.deleteCompany(orgId, confirmSlug, reason || undefined)
    // Straight back to the list — /platform/companies, not /platform, which is
    // the overview. The list is what renders the notice below, so the wrong one
    // of those two means the confirmation is never seen.
    navigate('/platform/companies', {
      replace: true,
      state: { notice: `${result.name} (${result.slug}) was deleted permanently.` },
    })
  }

  if (error && !company) return <ErrorNote>{error}</ErrorNote>
  if (!company) return <p className="pf-empty">Loading…</p>

  const usage = company.usage

  return (
    <div>
      <div className="pf-head">
        <div>
          <Link className="pf-back" to="/platform">← All companies</Link>
          <h1 className="pf-title">{company.name}</h1>
          <p className="pf-sub">
            {company.slug} · {company.timezone} · joined {company.created_at.slice(0, 10)}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <StatusPill value={company.status} />
          <button className="btn" disabled={busy} onClick={() => setEditing(true)}>
            Edit
          </button>
          {company.status === 'suspended' ? (
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => run(() => platformApi.activate(orgId), 'Company reactivated.')}
            >
              Reactivate
            </button>
          ) : (
            <button className="btn" disabled={busy} onClick={suspend}>
              Suspend
            </button>
          )}
          {/* Sits apart from the reversible actions. Suspend used to carry the
              danger styling; it is the one that undoes, so it no longer does. */}
          <button className="btn pf-btn-danger" disabled={busy} onClick={() => setDeleting(true)}>
            Delete
          </button>
        </div>
      </div>

      {notice && <div className="pf-notice">{notice}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {company.status === 'suspended' && company.suspended_reason && (
        <div className="pf-warn-box">
          <b>Suspended.</b> {company.suspended_reason}
          <div className="pf-muted" style={{ marginTop: 6 }}>
            Agents were deactivated. Reactivating the company does not re-enable them — each
            machine must enrol again.
          </div>
        </div>
      )}

      <div className="pf-tiles">
        <div className="pf-tile">
          <div className="pf-tile-label">Plan</div>
          <div className="pf-tile-value" style={{ fontSize: 20 }}>{usage.plan_name}</div>
          <div className="pf-tile-meta"><StatusPill value={usage.status} /></div>
        </div>
        <div className="pf-tile">
          <div className="pf-tile-label">Seats</div>
          <div className="pf-tile-value">{usage.seats_used}<span className="pf-of">/{usage.seat_limit}</span></div>
          <div className="pf-tile-meta">{usage.seats_available} available</div>
        </div>
        <div className="pf-tile">
          <div className="pf-tile-label">Renews in</div>
          <div className="pf-tile-value">{usage.days_remaining ?? '—'}<span className="pf-of"> days</span></div>
          <div className="pf-tile-meta">{company.period_end?.slice(0, 10) ?? 'no period set'}</div>
        </div>
        <div className="pf-tile">
          <div className="pf-tile-label">Screenshots stored</div>
          <div className="pf-tile-value">{usage.screenshots.toLocaleString('en-IN')}</div>
          <div className="pf-tile-meta">{bytes(usage.storage_bytes)} of {usage.storage_gb_limit} GB</div>
        </div>
      </div>

      <div className="pf-grid-2">
        <section className="pf-card">
          <h2 className="pf-card-title">Company details</h2>
          <dl className="pf-dl">
            <div><dt>Legal name</dt><dd>{company.legal_name ?? '—'}</dd></div>
            <div><dt>Admin</dt><dd>{company.admin_name ?? '—'}<br /><span className="pf-muted">{company.admin_email ?? ''}</span></dd></div>
            <div><dt>Billing email</dt><dd>{company.contact_email ?? '—'}</dd></div>
            <div><dt>Phone</dt><dd>{company.contact_phone ?? '—'}</dd></div>
            <div><dt>Location</dt><dd>{[company.city, company.state, company.country].filter(Boolean).join(', ') || '—'}</dd></div>
            <div><dt>GSTIN</dt><dd>{company.gstin ?? '—'}</dd></div>
            <div><dt>Workspace</dt><dd>{company.slug}</dd></div>
          </dl>
        </section>

        <OverridePanel
          orgId={orgId}
          company={company}
          busy={busy}
          onApplied={(message) => run(async () => {}, message)}
          onError={setError}
          reload={load}
        />
      </div>

      <CompanyModules orgId={orgId} />

      <section className="pf-card">
        <h2 className="pf-card-title">Subscription history</h2>
        <div className="table-wrap">
          <table className="pf-table">
            <thead>
              <tr>
                <th>Created</th><th>Plan</th><th>Cycle</th><th className="num">Seats</th>
                <th className="num">Total</th><th>Period</th><th>Status</th><th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {company.subscriptions.map((s) => (
                <tr key={s.id}>
                  <td>{s.created_at.slice(0, 10)}</td>
                  <td>{s.plan_id}</td>
                  <td>{s.billing_cycle}</td>
                  <td className="num">{s.seats}</td>
                  <td className="num">{rupees(s.total_amount)}</td>
                  <td className="pf-muted">
                    {s.period_start?.slice(0, 10) ?? '—'} → {s.period_end?.slice(0, 10) ?? '—'}
                  </td>
                  <td><StatusPill value={s.status} /></td>
                  <td className="pf-muted">{s.notes ?? ''}</td>
                </tr>
              ))}
              {company.subscriptions.length === 0 && (
                <tr><td colSpan={8} className="pf-empty">No subscriptions yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="pf-card">
        <h2 className="pf-card-title">Payments</h2>
        <div className="table-wrap">
          <table className="pf-table">
            <thead>
              <tr>
                <th>Date</th><th>Order</th><th>Payment</th><th className="num">Amount</th>
                <th>Method</th><th>Status</th><th>Error</th>
              </tr>
            </thead>
            <tbody>
              {company.payments.map((p) => (
                <tr key={p.id}>
                  <td>{(p.paid_at ?? p.created_at).slice(0, 10)}</td>
                  <td className="pf-mono">{p.order_id}</td>
                  <td className="pf-mono">{p.payment_id ?? '—'}</td>
                  <td className="num">{rupees(p.amount)}</td>
                  <td>{p.method ?? '—'}</td>
                  <td><StatusPill value={p.status} /></td>
                  <td className="pf-muted">{p.error_description ?? ''}</td>
                </tr>
              ))}
              {company.payments.length === 0 && (
                <tr><td colSpan={7} className="pf-empty">No payment attempts recorded.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {editing && (
        <CompanyEdit company={company} onClose={() => setEditing(false)} onSave={saveCompany} />
      )}
      {deleting && (
        <CompanyDelete company={company} onClose={() => setDeleting(false)} onConfirm={destroy} />
      )}

      <div className="pf-grid-2">
        <section className="pf-card">
          <h2 className="pf-card-title">
            Employees <span className="pf-muted">({employees.length})</span>
          </h2>
          <p className="pf-hint" style={{ marginTop: -6 }}>
            Roster only. This console cannot reach any company's activity data or screenshots.
          </p>
          <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table className="pf-table">
              <thead>
                <tr><th>Name</th><th>Role</th><th>Team</th><th>Agent</th></tr>
              </thead>
              <tbody>
                {employees.map((e) => (
                  <tr key={e.id}>
                    <td>
                      {e.full_name}
                      <div className="pf-muted">{e.email}</div>
                    </td>
                    <td>{e.role}</td>
                    <td>{e.team ?? '—'}</td>
                    <td>
                      {e.is_online ? (
                        <span className="pf-pill pf-pill-ok">online</span>
                      ) : (
                        <span className="pf-muted">
                          {e.last_seen_at ? e.last_seen_at.slice(0, 10) : 'never'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {employees.length === 0 && (
                  <tr><td colSpan={4} className="pf-empty">No employees yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="pf-card">
          <h2 className="pf-card-title">Recent activity</h2>
          <ul className="pf-activity">
            {company.recent_activity.map((entry, index) => (
              <li key={index}>
                <span className="pf-activity-action">{entry.action.replace(/[._]/g, ' ')}</span>
                <span className="pf-muted">{entry.at?.slice(0, 16).replace('T', ' ') ?? ''}</span>
              </li>
            ))}
            {company.recent_activity.length === 0 && (
              <li className="pf-empty">Nothing recorded yet.</li>
            )}
          </ul>
        </section>
      </div>
    </div>
  )
}

function OverridePanel({
  orgId,
  company,
  busy,
  onError,
  reload,
}: {
  orgId: string
  company: CompanyDetail
  busy: boolean
  onApplied: (message: string) => void
  onError: (message: string) => void
  reload: () => Promise<void>
}) {
  const [draft, setDraft] = useState<SubscriptionOverride>({})
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  // From the catalogue, not a hard-coded three: a plan an operator added is
  // useless if it cannot be assigned to anybody.
  const [plans, setPlans] = useState<PlanRow[]>([])

  useEffect(() => {
    platformApi.plans().then(setPlans).catch(() => setPlans([]))
  }, [])

  async function apply() {
    if (Object.keys(draft).length === 0) return
    setSaving(true)
    setDone(null)
    try {
      await platformApi.overrideSubscription(orgId, draft)
      await reload()
      setDraft({})
      setDone('Subscription updated.')
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not update the subscription')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="pf-card">
      <h2 className="pf-card-title">Adjust subscription</h2>
      <p className="pf-hint" style={{ marginTop: -6 }}>
        Operator override — applied immediately, with no payment taken. Every change is written to
        the audit log with your account against it.
      </p>

      <div className="pf-form-grid">
        <label>
          Plan
          <select
            value={draft.plan_id ?? company.plan_id}
            onChange={(e) => setDraft({ ...draft, plan_id: e.target.value })}
          >
            {/* A plan withdrawn from sale still appears when this company is on
                it — otherwise the select would silently show a different plan
                than the one they are actually paying for. */}
            {plans
              .filter((p) => p.is_active || p.id === company.plan_id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.id}){p.is_active ? '' : ' — withdrawn'}
                </option>
              ))}
            {plans.length === 0 && <option value={company.plan_id}>{company.plan_name}</option>}
          </select>
        </label>
        <label>
          Seats
          <input
            type="number"
            min={company.usage.seats_used || 1}
            value={draft.seats ?? company.seat_limit}
            onChange={(e) => setDraft({ ...draft, seats: Number(e.target.value) })}
          />
          <span className="pf-hint">
            Cannot go below {company.usage.seats_used} — that many employees are active.
          </span>
        </label>
        <label>
          Status
          <select
            value={draft.status ?? company.subscription_status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value })}
          >
            {['trialing', 'pending_payment', 'active', 'past_due', 'expired', 'canceled', 'suspended'].map(
              (s) => <option key={s} value={s}>{s}</option>,
            )}
          </select>
        </label>
        <label>
          Extend by (days)
          <input
            type="number"
            min={1}
            placeholder="0"
            value={draft.extend_days ?? ''}
            onChange={(e) =>
              setDraft({ ...draft, extend_days: e.target.value ? Number(e.target.value) : undefined })
            }
          />
          <span className="pf-hint">Added to the current period end.</span>
        </label>
      </div>

      <label style={{ display: 'block', marginTop: 12 }}>
        Reason
        <input
          type="text"
          placeholder="e.g. extended trial agreed with sales"
          value={draft.notes ?? ''}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          style={{ width: '100%' }}
        />
      </label>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14 }}>
        <button
          className="btn btn-primary"
          disabled={busy || saving || Object.keys(draft).length === 0}
          onClick={apply}
        >
          {saving ? 'Applying…' : 'Apply override'}
        </button>
        {done && <span className="pf-ok">{done}</span>}
      </div>
    </section>
  )
}
