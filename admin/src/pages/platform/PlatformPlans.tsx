import { useCallback, useEffect, useState } from 'react'
import { ErrorNote } from '../../components/ui'
import {
  platformApi,
  rupees,
  type PlanCreate,
  type PlanRow,
  type PlanWrite,
} from '../../lib/platformApi'
import PlanEditor from './PlanEditor'

/**
 * The plan catalogue.
 *
 * This page used to be read-only, on the reasoning that pricing belongs in code
 * so it cannot drift between deployments. That was right about drift and wrong
 * about the job: an operator who agrees a rate on a call needs the plan to
 * exist that afternoon, and until it did, the subscription override was used to
 * fake one — leaving the subscription saying "standard" while the customer was
 * on something else entirely. The catalogue is data now, and this is where it
 * is edited.
 */
export default function PlatformPlans() {
  const [plans, setPlans] = useState<PlanRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** null = closed, 'new' = the create form, otherwise the plan being edited. */
  const [editing, setEditing] = useState<PlanRow | 'new' | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setPlans(await platformApi.plans())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the plans')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function save(body: PlanWrite | PlanCreate) {
    if (editing === 'new') {
      const created = await platformApi.createPlan(body as PlanCreate)
      setNotice(`${created.name} added.`)
    } else if (editing) {
      const saved = await platformApi.updatePlan(editing.id, body)
      // A tightened limit is applied to the companies already on the plan, and
      // that is not something to leave the operator to discover later.
      setNotice(
        saved.organizations_clamped
          ? `${saved.name} saved. Tracking settings were reduced for ` +
            `${saved.organizations_clamped} compan${saved.organizations_clamped === 1 ? 'y' : 'ies'} ` +
            'already on this plan.'
          : `${saved.name} saved.`,
      )
    }
    setEditing(null)
    await load()
  }

  async function remove(plan: PlanRow) {
    const confirmed = window.confirm(
      `Delete the "${plan.name}" plan?\n\n` +
        'This removes it from the catalogue permanently. It is only possible ' +
        'because no subscription is on it.',
    )
    if (!confirmed) return
    setBusyId(plan.id)
    setError(null)
    setNotice(null)
    try {
      await platformApi.deletePlan(plan.id)
      setNotice(`${plan.name} deleted.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the plan')
    } finally {
      setBusyId(null)
    }
  }

  async function toggleActive(plan: PlanRow) {
    setBusyId(plan.id)
    setError(null)
    setNotice(null)
    try {
      await platformApi.updatePlan(plan.id, { is_active: !plan.is_active })
      setNotice(plan.is_active ? `${plan.name} is no longer offered.` : `${plan.name} is on sale again.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the plan')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <div className="pf-head">
        <div>
          <h1 className="pf-title">Plans</h1>
          <p className="pf-sub">
            What each plan costs and what it allows. Changing a limit here applies to
            every company already on the plan. To move one customer, use their company page.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          Add plan
        </button>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && <div className="pf-notice">{notice}</div>}

      {!plans ? (
        <p className="pf-muted">Loading…</p>
      ) : (
        <div className="pf-plangrid">
          {plans.map((p) => (
            <div className={`pf-card pf-plan${p.is_active ? '' : ' pf-plan-off'}`} key={p.id}>
              <div className="pf-card-head">
                <h2 className="pf-card-title">{p.name}</h2>
                <code className="pf-code">{p.id}</code>
              </div>

              <div className="pf-plan-flags">
                {!p.is_active && <span className="pf-pill pf-pill-bad">not offered</span>}
                {p.is_active && !p.is_public && (
                  <span className="pf-pill pf-pill-warn" title="Usable, but not shown on the public pricing page">
                    operator only
                  </span>
                )}
                {p.is_builtin && <span className="pf-pill pf-pill-neutral">built-in</span>}
                <span className="pf-muted pf-plan-usage">
                  {p.subscriptions === 0
                    ? 'no subscriptions'
                    : `${p.subscriptions} subscription${p.subscriptions === 1 ? '' : 's'}`}
                </span>
              </div>

              {p.description && <p className="pf-plan-desc">{p.description}</p>}

              <div className="pf-plan-price">
                {rupees(p.base_price_annual)}<span> / year</span>
              </div>
              <div className="pf-plan-price-sub">
                + {rupees(p.per_employee_month)} per employee / month
              </div>

              <dl className="pf-kv">
                <div><dt>Employees</dt><dd>{p.min_employees}–{p.max_employees}</dd></div>
                <div><dt>Storage</dt><dd>{p.storage_gb} GB</dd></div>
                <div><dt>Screenshot retention</dt><dd>up to {p.max_screenshot_retention_days} days</dd></div>
                <div><dt>Activity retention</dt><dd>up to {p.max_activity_retention_days} days</dd></div>
                <div><dt>Fastest capture</dt><dd>{captureRate(p.min_screenshot_interval_s)}</dd></div>
              </dl>

              {p.features.length > 0 && (
                <ul className="pf-features">
                  {p.features.map((f) => <li key={f}>{f}</li>)}
                </ul>
              )}

              <div className="pf-plan-actions">
                <button className="btn btn-sm" disabled={busyId === p.id} onClick={() => setEditing(p)}>
                  Edit
                </button>
                <button className="btn btn-sm" disabled={busyId === p.id} onClick={() => toggleActive(p)}>
                  {p.is_active ? 'Stop offering' : 'Offer again'}
                </button>
                {/* Built-ins and plans somebody is paying for cannot go. The
                    button is absent rather than disabled: an operator should
                    not have to click something to find out it was never on. */}
                {!p.is_builtin && p.subscriptions === 0 && (
                  <button
                    className="btn btn-sm pf-btn-danger"
                    disabled={busyId === p.id}
                    onClick={() => remove(p)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <PlanEditor
          plan={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </div>
  )
}

/** "every 45s" reads better than "every 0.75 min" for a sub-minute interval. */
function captureRate(seconds: number): string {
  if (seconds < 60) return `every ${seconds}s`
  const minutes = seconds / 60
  return `every ${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`
}
