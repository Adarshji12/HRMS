import { useEffect, useState, type FormEvent } from 'react'
import { platformApi, type CompanyCreated, type PlanRow } from '../../lib/platformApi'
import { IconAlert, IconCheck } from '../../components/Icons'

/**
 * Provisioning a workspace by hand.
 *
 * Public signup exists for self-serve customers. This is for the ones who
 * arrive by phone, sign a paper contract, or pay by bank transfer — an operator
 * should not have to walk them through a checkout that then has to be
 * overridden, nor create the row in SQL.
 */

const BLANK = {
  name: '', slug: '', timezone: 'Asia/Kolkata',
  owner_name: '', owner_email: '', owner_password: '',
  plan_id: 'standard', seats: 25, valid_days: 365, notes: '',
  legal_name: '', contact_phone: '', gstin: '', city: '', country: 'IN',
  send_welcome_email: true,
}

/** "Northwind Traders Pvt Ltd" -> "northwind-traders-pvt-ltd". */
function slugify(name: string): string {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

export default function NewCompany({
  onCreated,
  onClose,
}: {
  onCreated?: () => void
  onClose?: () => void
}) {
  const [form, setForm] = useState(BLANK)
  // Once the operator edits the slug it stops following the name, or their
  // deliberate choice gets overwritten on the next keystroke.
  const [slugTouched, setSlugTouched] = useState(false)
  // The catalogue, not a hard-coded three. A plan an operator added is no use
  // if the one form that provisions a paying customer cannot offer it.
  const [plans, setPlans] = useState<PlanRow[]>([])

  useEffect(() => {
    platformApi.plans().then(setPlans).catch(() => setPlans([]))
  }, [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<CompanyCreated | null>(null)

  function set<K extends keyof typeof BLANK>(key: K, value: (typeof BLANK)[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError(null)
    try {
      const created = await platformApi.createCompany({
        name: form.name.trim(),
        slug: (slugTouched ? form.slug : slugify(form.name)).trim(),
        timezone: form.timezone,
        owner_name: form.owner_name.trim(),
        owner_email: form.owner_email.trim(),
        ...(form.owner_password ? { owner_password: form.owner_password } : {}),
        plan_id: form.plan_id,
        seats: Number(form.seats),
        valid_days: Number(form.valid_days),
        ...(form.notes ? { notes: form.notes } : {}),
        ...(form.legal_name ? { legal_name: form.legal_name } : {}),
        ...(form.contact_phone ? { contact_phone: form.contact_phone } : {}),
        ...(form.gstin ? { gstin: form.gstin } : {}),
        ...(form.city ? { city: form.city } : {}),
        country: form.country,
        send_welcome_email: form.send_welcome_email,
      })
      setDone(created)
      onCreated?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the company')
    } finally { setBusy(false) }
  }

  if (done) {
    return (
      <div className="pf-card pf-created">
        <div className="pf-card-head">
          <h2 className="pf-card-title">
            <IconCheck size={16} /> {done.name} is ready
          </h2>
        </div>

        {/* The one moment this password exists in readable form. It is hashed
            in the database, so if this panel is closed without copying it the
            owner has to go through password reset. */}
        {done.generated_password && (
          <div className="pf-warn-box">
            <b>Copy the password now.</b> It is stored only as a hash — closing this
            panel is the last you will see of it. If it is lost, the owner must use
            password reset.
          </div>
        )}

        <dl className="pf-kv">
          <div><dt>Sign-in address</dt><dd><a href={done.login_url} className="pf-link">{done.login_url}</a></dd></div>
          <div><dt>Owner</dt><dd>{done.owner_email}</dd></div>
          <div><dt>Password</dt><dd><code className="pf-code">{done.owner_password}</code></dd></div>
          <div><dt>Plan</dt><dd>{done.plan} · {done.seats} seats</dd></div>
          <div><dt>Status</dt><dd>{done.status}</dd></div>
          <div>
            <dt>Welcome email</dt>
            <dd>
              {done.welcome_email_sent
                ? 'sent'
                : 'not sent — no mail connector configured'}
            </dd>
          </div>
        </dl>

        <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
          <button
            className="btn"
            onClick={() => {
              void navigator.clipboard?.writeText(
                `${done.login_url}\n${done.owner_email}\n${done.owner_password}`,
              )
            }}
          >
            Copy sign-in details
          </button>
          <button className="btn" onClick={() => { setDone(null); setForm(BLANK); setSlugTouched(false) }}>
            Add another
          </button>
          <button className="btn" onClick={() => onClose?.()}>
            Done
          </button>
        </div>
      </div>
    )
  }

  const slug = slugTouched ? form.slug : slugify(form.name)

  return (
    <form className="pf-card" onSubmit={submit}>
      <div className="pf-card-head">
        <h2 className="pf-card-title">New company</h2>
        <span className="pf-muted">for customers who did not sign up themselves</span>
      </div>

      {error && <div className="pf-warn-box"><IconAlert size={15} /> {error}</div>}

      <div className="pf-form-grid">
        <label className="pf-field">
          Company name
          <input
            value={form.name} required
            onChange={(e) => set('name', e.target.value)}
            placeholder="Northwind Traders"
          />
        </label>
        <label className="pf-field">
          Workspace address
          <input
            value={slug} required
            onChange={(e) => { setSlugTouched(true); set('slug', e.target.value) }}
            pattern="[a-z0-9][a-z0-9\-]*[a-z0-9]"
            placeholder="northwind"
          />
          <span className="pf-hint">
            They will sign in at <b>{slug || 'name'}.yourdomain.com</b>. Cannot be changed later.
          </span>
        </label>
        <label className="pf-field">
          Timezone
          <input value={form.timezone} onChange={(e) => set('timezone', e.target.value)} />
          <span className="pf-hint">Every report and working-hours rule is read in this zone.</span>
        </label>
      </div>

      <h3 className="pf-form-section">Owner account</h3>
      <div className="pf-form-grid">
        <label className="pf-field">
          Full name
          <input value={form.owner_name} required onChange={(e) => set('owner_name', e.target.value)} placeholder="Rita Kapoor" />
        </label>
        <label className="pf-field">
          Email
          <input type="email" value={form.owner_email} required onChange={(e) => set('owner_email', e.target.value)} placeholder="rita@northwind.com" />
        </label>
        <label className="pf-field">
          Password
          <input
            type="text" value={form.owner_password}
            onChange={(e) => set('owner_password', e.target.value)}
            placeholder="leave blank to generate a strong one"
            autoComplete="off"
          />
          <span className="pf-hint">Shown once after creation, then only as a hash.</span>
        </label>
      </div>

      <h3 className="pf-form-section">Subscription</h3>
      <div className="pf-form-grid">
        <label className="pf-field">
          Plan
          <select value={form.plan_id} onChange={(e) => set('plan_id', e.target.value)}>
            {plans
              .filter((p) => p.is_active)
              .map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            {/* Until the catalogue loads, the default the form starts on still
                has to be a valid option or the select shows blank. */}
            {plans.length === 0 && <option value={form.plan_id}>{form.plan_id}</option>}
          </select>
          <span className="pf-hint">
            {form.plan_id === 'trial'
              ? 'Starts as a trial, exactly like self-serve signup.'
              : 'Marked active immediately — no payment is taken here.'}
          </span>
        </label>
        <label className="pf-field">
          Seats
          <input type="number" min={1} max={100000} value={form.seats} onChange={(e) => set('seats', Number(e.target.value))} />
        </label>
        <label className="pf-field">
          Valid for (days)
          <input type="number" min={1} max={3650} value={form.valid_days} onChange={(e) => set('valid_days', Number(e.target.value))} />
        </label>
      </div>

      <h3 className="pf-form-section">Billing details <span className="pf-muted">optional</span></h3>
      <div className="pf-form-grid">
        <label className="pf-field">
          Legal name
          <input value={form.legal_name} onChange={(e) => set('legal_name', e.target.value)} placeholder="Northwind Traders Pvt Ltd" />
        </label>
        <label className="pf-field">
          GSTIN
          <input value={form.gstin} onChange={(e) => set('gstin', e.target.value)} placeholder="27AAACN1234A1Z5" />
        </label>
        <label className="pf-field">
          Phone
          <input value={form.contact_phone} onChange={(e) => set('contact_phone', e.target.value)} />
        </label>
        <label className="pf-field">
          City
          <input value={form.city} onChange={(e) => set('city', e.target.value)} />
        </label>
      </div>

      <label className="pf-field" style={{ marginTop: 12 }}>
        Internal note
        <input
          value={form.notes} onChange={(e) => set('notes', e.target.value)}
          placeholder="Signed by bank transfer, invoice INV-4412"
        />
        <span className="pf-hint">Kept on the subscription. The customer never sees it.</span>
      </label>

      <label className="pf-check" style={{ marginTop: 14 }}>
        <input
          type="checkbox" checked={form.send_welcome_email}
          onChange={(e) => set('send_welcome_email', e.target.checked)}
        />
        <span>Email the owner a welcome message with their sign-in link</span>
      </label>

      <div style={{ marginTop: 18 }}>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create company'}
        </button>
      </div>
    </form>
  )
}
