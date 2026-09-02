import { useEffect, useState, type FormEvent } from 'react'
import { ErrorNote } from '../../components/ui'
import type { PlanCreate, PlanRow, PlanWrite } from '../../lib/platformApi'

/**
 * Create or edit one plan.
 *
 * Prices are typed in rupees and sent in paise. The conversion happens once, on
 * the way out, and every value in between is an integer — the same reason the
 * server refuses to hold money as a float. A price typed as 4999.5 is rounded
 * here rather than silently truncated by the API.
 */

interface Draft {
  id: string
  name: string
  description: string
  /** Rupees, as typed. Converted to paise on submit. */
  base_price_annual: string
  per_employee_month: string
  min_employees: string
  max_employees: string
  max_screenshot_retention_days: string
  max_activity_retention_days: string
  min_screenshot_interval_s: string
  storage_gb: string
  /** One feature per line — a textarea, because a list of chips to manage is a
      worse job than typing four lines. */
  features: string
  is_active: boolean
  is_public: boolean
  sort_order: string
}

const BLANK: Draft = {
  id: '',
  name: '',
  description: '',
  base_price_annual: '0',
  per_employee_month: '0',
  min_employees: '1',
  max_employees: '100',
  max_screenshot_retention_days: '30',
  max_activity_retention_days: '90',
  min_screenshot_interval_s: '300',
  storage_gb: '10',
  features: '',
  is_active: true,
  is_public: true,
  sort_order: '100',
}

function draftFrom(plan: PlanRow): Draft {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description ?? '',
    base_price_annual: paiseToRupees(plan.base_price_annual),
    per_employee_month: paiseToRupees(plan.per_employee_month),
    min_employees: String(plan.min_employees),
    max_employees: String(plan.max_employees),
    max_screenshot_retention_days: String(plan.max_screenshot_retention_days),
    max_activity_retention_days: String(plan.max_activity_retention_days),
    min_screenshot_interval_s: String(plan.min_screenshot_interval_s),
    storage_gb: String(plan.storage_gb),
    features: plan.features.join('\n'),
    is_active: plan.is_active,
    is_public: plan.is_public,
    sort_order: String(plan.sort_order),
  }
}

function paiseToRupees(paise: number): string {
  return String(paise / 100)
}

function rupeesToPaise(value: string): number {
  const amount = Number(value)
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0
}

function whole(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback
}

/** Lowercase, hyphenated, no leading or trailing punctuation — what the API accepts. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 32)
}

export default function PlanEditor({
  plan,
  onClose,
  onSave,
}: {
  /** null for a new plan. */
  plan: PlanRow | null
  onClose: () => void
  onSave: (body: PlanWrite | PlanCreate) => Promise<void>
}) {
  const [draft, setDraft] = useState<Draft>(() => (plan ? draftFrom(plan) : BLANK))
  // Only while creating. Once the operator edits the id by hand, the name stops
  // driving it, or fixing a typo in the id gets undone by the next keystroke.
  const [slugTouched, setSlugTouched] = useState(plan !== null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  const minEmployees = whole(draft.min_employees, 1)
  const maxEmployees = whole(draft.max_employees, 1)
  const rangeInverted = maxEmployees < minEmployees

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (rangeInverted) {
      setError('The maximum headcount cannot be below the minimum.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const body: PlanWrite = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        base_price_annual: rupeesToPaise(draft.base_price_annual),
        per_employee_month: rupeesToPaise(draft.per_employee_month),
        min_employees: minEmployees,
        max_employees: maxEmployees,
        max_screenshot_retention_days: whole(draft.max_screenshot_retention_days, 30),
        max_activity_retention_days: whole(draft.max_activity_retention_days, 90),
        min_screenshot_interval_s: whole(draft.min_screenshot_interval_s, 300),
        storage_gb: whole(draft.storage_gb, 10),
        features: draft.features
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        is_active: draft.is_active,
        is_public: draft.is_public,
        sort_order: whole(draft.sort_order, 100),
      }
      await onSave(plan ? body : { ...body, id: slugify(draft.id) })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the plan')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="hx-backdrop" onMouseDown={onClose}>
      <form className="hx-dialog plan-dialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="hx-dialog-head">
          <h2 className="hx-dialog-title">{plan ? `Edit ${plan.name}` : 'New plan'}</h2>
          <p className="muted-sm">
            {plan
              ? 'Tightening a limit applies to the companies already on this plan.'
              : 'Prices are in rupees. The plan is available to assign as soon as it is saved.'}
          </p>
        </div>

        <div className="hx-list plan-body">
          {error && <div style={{ marginBottom: 12 }}><ErrorNote>{error}</ErrorNote></div>}

          <div className="pf-form-grid">
            <label className="pf-field">
              Plan name
              <input
                value={draft.name}
                onChange={(e) => {
                  const name = e.target.value
                  setDraft((d) => ({
                    ...d,
                    name,
                    id: !plan && !slugTouched ? slugify(name) : d.id,
                  }))
                }}
                required
                minLength={2}
                placeholder="Growth"
              />
            </label>

            <label className="pf-field">
              Plan id
              <input
                value={draft.id}
                onChange={(e) => {
                  setSlugTouched(true)
                  set('id', e.target.value)
                }}
                readOnly={plan !== null}
                required
                pattern="[a-z0-9][a-z0-9_\-]*[a-z0-9]"
                placeholder="growth"
              />
              {/* Every subscription stores this string. Changing it later would
                  orphan them onto trial limits, so it is fixed at creation. */}
              <span className="pf-hint">
                {plan
                  ? 'Fixed — every subscription on this plan stores it.'
                  : 'Lowercase, no spaces. Cannot be changed later.'}
              </span>
            </label>
          </div>

          <label className="pf-field" style={{ marginTop: 14 }}>
            Description
            <input
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="The everyday plan for a growing team."
            />
          </label>

          <div className="pf-form-section">Price</div>
          <div className="pf-form-grid">
            <label className="pf-field">
              Base fee (₹ / year)
              <input
                type="number"
                min={0}
                step="0.01"
                value={draft.base_price_annual}
                onChange={(e) => set('base_price_annual', e.target.value)}
              />
              <span className="pf-hint">Charged regardless of headcount.</span>
            </label>
            <label className="pf-field">
              Per employee (₹ / month)
              <input
                type="number"
                min={0}
                step="0.01"
                value={draft.per_employee_month}
                onChange={(e) => set('per_employee_month', e.target.value)}
              />
              <span className="pf-hint">Multiplied by seats and by the billing period.</span>
            </label>
          </div>

          <div className="pf-form-section">Headcount</div>
          <div className="pf-form-grid">
            <label className="pf-field">
              Minimum employees
              <input
                type="number"
                min={1}
                value={draft.min_employees}
                onChange={(e) => set('min_employees', e.target.value)}
              />
            </label>
            <label className="pf-field">
              Maximum employees
              <input
                type="number"
                min={1}
                value={draft.max_employees}
                onChange={(e) => set('max_employees', e.target.value)}
                aria-invalid={rangeInverted}
              />
              {rangeInverted && (
                <span className="pf-hint pf-danger">
                  Must be at least the minimum, or every quote bills one seat.
                </span>
              )}
            </label>
          </div>

          <div className="pf-form-section">
            Limits
            <span className="pf-muted"> — the ceiling a company on this plan can set</span>
          </div>
          <div className="pf-form-grid">
            <label className="pf-field">
              Screenshot retention (days)
              <input
                type="number"
                min={1}
                max={3650}
                value={draft.max_screenshot_retention_days}
                onChange={(e) => set('max_screenshot_retention_days', e.target.value)}
              />
            </label>
            <label className="pf-field">
              Activity retention (days)
              <input
                type="number"
                min={1}
                max={3650}
                value={draft.max_activity_retention_days}
                onChange={(e) => set('max_activity_retention_days', e.target.value)}
              />
            </label>
            <label className="pf-field">
              Fastest capture (seconds)
              <input
                type="number"
                min={30}
                max={86400}
                value={draft.min_screenshot_interval_s}
                onChange={(e) => set('min_screenshot_interval_s', e.target.value)}
              />
              <span className="pf-hint">A floor: nobody on this plan captures more often.</span>
            </label>
            <label className="pf-field">
              Storage (GB)
              <input
                type="number"
                min={1}
                value={draft.storage_gb}
                onChange={(e) => set('storage_gb', e.target.value)}
              />
            </label>
          </div>

          <div className="pf-form-section">
            Features
            <span className="pf-muted"> — one per line, shown on the pricing page</span>
          </div>
          <textarea
            className="plan-features-input"
            rows={5}
            value={draft.features}
            onChange={(e) => set('features', e.target.value)}
            placeholder={'Activity, apps & website tracking\nTimesheets, projects & reports'}
          />

          <div className="pf-form-section">Availability</div>
          <label className="perm-row">
            <input
              type="checkbox"
              checked={draft.is_active}
              onChange={(e) => set('is_active', e.target.checked)}
            />
            <span className="perm-body">
              <span className="perm-label">Offered</span>
              <span className="perm-desc">
                Switching this off withdraws the plan from sale. Companies already on it
                keep the limits they were sold — nothing about their subscription changes.
              </span>
            </span>
          </label>
          <label className="perm-row">
            <input
              type="checkbox"
              checked={draft.is_public}
              disabled={!draft.is_active}
              onChange={(e) => set('is_public', e.target.checked)}
            />
            <span className="perm-body">
              <span className="perm-label">Shown on the public pricing page</span>
              <span className="perm-desc">
                Leave this off for a negotiated rate: it stays fully assignable from a
                company page, it just is not advertised.
              </span>
            </span>
          </label>

          <label className="pf-field" style={{ marginTop: 14, maxWidth: 200 }}>
            Sort order
            <input
              type="number"
              min={0}
              value={draft.sort_order}
              onChange={(e) => set('sort_order', e.target.value)}
            />
            <span className="pf-hint">Lower comes first.</span>
          </label>
        </div>

        <div className="hx-dialog-foot">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : plan ? 'Save plan' : 'Create plan'}
          </button>
        </div>
      </form>
    </div>
  )
}
