import { useEffect, useState, type FormEvent } from 'react'
import { ErrorNote } from '../../components/ui'
import type { CompanyDetail, CompanyUpdate } from '../../lib/platformApi'

/**
 * Correct a company's own details.
 *
 * Deliberately does not touch the subscription. "Fix the spelling of the
 * company name" and "give them forty more seats" are different decisions with
 * different consequences, and the override panel is right there for the second
 * one.
 */

interface Draft {
  name: string
  slug: string
  timezone: string
  legal_name: string
  contact_email: string
  contact_phone: string
  address_line1: string
  city: string
  state: string
  postal_code: string
  country: string
  gstin: string
  industry: string
}

function draftFrom(company: CompanyDetail): Draft {
  return {
    name: company.name,
    slug: company.slug,
    timezone: company.timezone,
    legal_name: company.legal_name ?? '',
    contact_email: company.contact_email ?? '',
    contact_phone: company.contact_phone ?? '',
    address_line1: '',
    city: company.city ?? '',
    state: company.state ?? '',
    postal_code: '',
    country: company.country ?? 'IN',
    gstin: company.gstin ?? '',
    industry: '',
  }
}

/** Fields the detail endpoint does not return, so a blank one means "unknown",
    not "cleared" — sending it would wipe an address nobody was editing. */
const WRITE_ONLY: Array<keyof Draft> = ['address_line1', 'postal_code', 'industry']

export default function CompanyEdit({
  company,
  onClose,
  onSave,
}: {
  company: CompanyDetail
  onClose: () => void
  onSave: (body: CompanyUpdate) => Promise<void>
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(company))
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

  const slugChanged = draft.slug.trim().toLowerCase() !== company.slug

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      // Only what changed. A PATCH that resends every field would rewrite ones
      // the operator never looked at, and would clear the address fields this
      // form cannot see.
      const original = draftFrom(company)
      const body: CompanyUpdate = {}
      for (const key of Object.keys(draft) as Array<keyof Draft>) {
        const next = draft[key].trim()
        if (WRITE_ONLY.includes(key) && !next) continue
        if (next === original[key]) continue
        // Blank means "no value" for the optional fields; the API takes null.
        ;(body as Record<string, unknown>)[key] = next || null
      }
      if (Object.keys(body).length === 0) {
        onClose()
        return
      }
      await onSave(body)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the company')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="hx-backdrop" onMouseDown={onClose}>
      <form className="hx-dialog plan-dialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="hx-dialog-head">
          <h2 className="hx-dialog-title">Edit {company.name}</h2>
          <p className="muted-sm">
            Company details only. Plan, seats and dates are on the subscription panel.
          </p>
        </div>

        <div className="hx-list plan-body">
          {error && <div style={{ marginBottom: 12 }}><ErrorNote>{error}</ErrorNote></div>}

          <div className="pf-form-grid">
            <label className="pf-field">
              Company name
              <input value={draft.name} onChange={(e) => set('name', e.target.value)} required minLength={2} />
            </label>
            <label className="pf-field">
              Workspace
              <input
                value={draft.slug}
                onChange={(e) => set('slug', e.target.value.toLowerCase())}
                pattern="[a-z0-9][a-z0-9\-]*[a-z0-9]"
                required
              />
              {/* Not a cosmetic field: it is the subdomain every enrolled agent
                  and every saved bookmark points at. */}
              <span className={`pf-hint${slugChanged ? ' pf-danger' : ''}`}>
                {slugChanged
                  ? 'Changing this changes the sign-in URL. Existing bookmarks will break.'
                  : 'The subdomain everyone signs in at.'}
              </span>
            </label>
            <label className="pf-field">
              Timezone
              <input value={draft.timezone} onChange={(e) => set('timezone', e.target.value)} />
            </label>
            <label className="pf-field">
              Legal name
              <input value={draft.legal_name} onChange={(e) => set('legal_name', e.target.value)} />
            </label>
          </div>

          <div className="pf-form-section">Billing contact</div>
          <div className="pf-form-grid">
            <label className="pf-field">
              Billing email
              <input
                type="email"
                value={draft.contact_email}
                onChange={(e) => set('contact_email', e.target.value)}
              />
            </label>
            <label className="pf-field">
              Phone
              <input value={draft.contact_phone} onChange={(e) => set('contact_phone', e.target.value)} />
            </label>
            <label className="pf-field">
              GSTIN
              <input value={draft.gstin} onChange={(e) => set('gstin', e.target.value)} />
            </label>
            <label className="pf-field">
              Industry
              <input
                value={draft.industry}
                onChange={(e) => set('industry', e.target.value)}
                placeholder="leave blank to keep"
              />
            </label>
          </div>

          <div className="pf-form-section">Address</div>
          <div className="pf-form-grid">
            <label className="pf-field">
              Street
              <input
                value={draft.address_line1}
                onChange={(e) => set('address_line1', e.target.value)}
                placeholder="leave blank to keep"
              />
            </label>
            <label className="pf-field">
              City
              <input value={draft.city} onChange={(e) => set('city', e.target.value)} />
            </label>
            <label className="pf-field">
              State
              <input value={draft.state} onChange={(e) => set('state', e.target.value)} />
            </label>
            <label className="pf-field">
              Postal code
              <input
                value={draft.postal_code}
                onChange={(e) => set('postal_code', e.target.value)}
                placeholder="leave blank to keep"
              />
            </label>
            <label className="pf-field">
              Country
              <input
                value={draft.country}
                onChange={(e) => set('country', e.target.value.toUpperCase())}
                maxLength={2}
                minLength={2}
                placeholder="IN"
              />
              <span className="pf-hint">Two-letter code.</span>
            </label>
          </div>
        </div>

        <div className="hx-dialog-foot">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  )
}
