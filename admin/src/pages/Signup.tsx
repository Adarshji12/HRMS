import { useEffect, useMemo, useState } from 'react'
import '../styles/signup.css'
import AuthShell from '../components/AuthShell'
import { ErrorNote } from '../components/ui'
import { BASE_DOMAIN, tenantUrl } from '../lib/tenant'
import {
  loadRazorpay,
  rupees,
  signupApi,
  slugify,
  type PlanOption,
  type Quote,
  type SignupComplete,
  type SlugCheck,
} from '../lib/signupApi'

type Step = 'company' | 'admin' | 'plan' | 'pay' | 'done'

const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'company', label: 'Company' },
  { id: 'admin', label: 'Administrator' },
  { id: 'plan', label: 'Plan' },
  { id: 'pay', label: 'Payment' },
]

const EMPTY_COMPANY = {
  name: '',
  slug: '',
  legal_name: '',
  contact_email: '',
  contact_phone: '',
  city: '',
  state: '',
  gstin: '',
  industry: '',
  country: 'IN',
  timezone: 'Asia/Kolkata',
}

const EMPTY_ADMIN = { full_name: '', email: '', password: '', phone: '' }

/** Back to the workspace sign-in this visitor came from (`?from=acme`), which
 *  asks only for email and password. Without one, the bare-domain sign-in. */
function loginHref(): string {
  const from = new URLSearchParams(window.location.search).get('from')?.toLowerCase()
  return from && /^[a-z0-9-]+$/.test(from) ? `${tenantUrl(from)}/login` : '/login'
}

export default function Signup() {
  const [step, setStep] = useState<Step>('company')
  const [company, setCompany] = useState({ ...EMPTY_COMPANY })
  const [admin, setAdmin] = useState({ ...EMPTY_ADMIN })
  const [planId, setPlanId] = useState('standard')
  const [employees, setEmployees] = useState(10)
  const [cycle, setCycle] = useState('annual')
  const [terms, setTerms] = useState(false)

  const [plans, setPlans] = useState<PlanOption[]>([])
  const [quote, setQuote] = useState<Quote | null>(null)
  const [slugState, setSlugState] = useState<SlugCheck | null>(null)
  const [complete, setComplete] = useState<SignupComplete | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    signupApi
      .plans()
      .then((available) => {
        setPlans(available)
        // The default is a guess made before the catalogue was known. An
        // operator can withdraw any plan from public sale, including the one
        // named here, and a preselected id that is not on offer leaves the
        // whole step with nothing selected.
        setPlanId((current) =>
          available.some((p) => p.id === current) ? current : available[0]?.id ?? current,
        )
      })
      .catch(() => setPlans([]))
  }, [])

  // Debounced availability check — one request per pause in typing, not per key.
  useEffect(() => {
    if (company.slug.length < 3) {
      setSlugState(null)
      return
    }
    const id = window.setTimeout(() => {
      signupApi.checkSlug(company.slug).then(setSlugState).catch(() => setSlugState(null))
    }, 400)
    return () => window.clearTimeout(id)
  }, [company.slug])

  // Price is always computed server-side; the browser never does money maths.
  useEffect(() => {
    if (planId === 'trial') {
      setQuote(null)
      return
    }
    let cancelled = false
    signupApi
      .quote(planId, employees, cycle)
      .then((q) => !cancelled && setQuote(q))
      .catch(() => !cancelled && setQuote(null))
    return () => {
      cancelled = true
    }
  }, [planId, employees, cycle])

  const selectedPlan = useMemo(() => plans.find((p) => p.id === planId), [plans, planId])

  function setCompanyField(field: keyof typeof EMPTY_COMPANY, value: string) {
    setCompany((c) => {
      const next = { ...c, [field]: value }
      // Auto-fill the subdomain from the company name until the user edits it.
      if (field === 'name' && (c.slug === '' || c.slug === slugify(c.name))) {
        next.slug = slugify(value)
      }
      return next
    })
  }

  const companyValid =
    company.name.trim().length >= 2 &&
    company.slug.length >= 3 &&
    slugState?.available === true &&
    /\S+@\S+\.\S+/.test(company.contact_email)

  const adminValid =
    admin.full_name.trim().length >= 2 &&
    /\S+@\S+\.\S+/.test(admin.email) &&
    admin.password.length >= 10

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const payload = {
        company: {
          ...company,
          legal_name: company.legal_name || null,
          contact_phone: company.contact_phone || null,
          city: company.city || null,
          state: company.state || null,
          gstin: company.gstin || null,
          industry: company.industry || null,
        },
        admin: { ...admin, phone: admin.phone || null },
        accept_terms: terms,
      }

      if (planId === 'trial') {
        setComplete(await signupApi.trial(payload))
        setStep('done')
        return
      }

      const order = await signupApi.start({
        ...payload,
        plan_id: planId,
        employees,
        billing_cycle: cycle,
      })

      if (order.simulated) {
        // No gateway credentials configured — run the same confirm path with a
        // locally signed callback so the flow is testable end to end.
        const callback = await signupApi.simulate(order.order_id)
        setComplete(await signupApi.confirm(callback))
        setStep('done')
        return
      }

      await loadRazorpay()
      await new Promise<void>((resolve, reject) => {
        const checkout = new (window as any).Razorpay({
          key: order.razorpay_key_id,
          amount: order.amount,
          currency: order.currency,
          name: 'LRS Services',
          description: `${order.quote.plan_name} · ${order.quote.employees} employees`,
          order_id: order.order_id,
          prefill: {
            name: order.prefill.name,
            email: order.prefill.email,
            contact: order.prefill.contact,
          },
          theme: { color: '#007392' },
          handler: async (response: Record<string, string>) => {
            try {
              setComplete(await signupApi.confirm(response))
              setStep('done')
              resolve()
            } catch (err) {
              reject(err)
            }
          },
          modal: {
            ondismiss: () =>
              reject(
                new Error(
                  'Payment was cancelled. Your details are saved — you can start again with the same workspace name.',
                ),
              ),
          },
        })
        checkout.on('payment.failed', (resp: any) =>
          reject(new Error(resp?.error?.description ?? 'The payment failed.')),
        )
        checkout.open()
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed')
    } finally {
      setBusy(false)
    }
  }

  if (step === 'done' && complete) return <Done complete={complete} />

  const stepIndex = STEPS.findIndex((s) => s.id === step)

  return (
    <AuthShell wide>
      <div className="signup-card">
        <h1 className="auth-title">Create your workspace</h1>
        <p className="auth-sub">
          Set up HR, payroll, attendance and operations for your company in a few minutes.
        </p>

        <ol className="stepper">
          {STEPS.map((s, index) => (
            <li
              key={s.id}
              className={`step ${index === stepIndex ? 'step-current' : ''} ${
                index < stepIndex ? 'step-done' : ''
              }`}
              aria-current={index === stepIndex ? 'step' : undefined}
            >
              <span className="step-dot">{index < stepIndex ? '✓' : index + 1}</span>
              <span className="step-label">{s.label}</span>
            </li>
          ))}
        </ol>

        {error && (
          <div style={{ marginBottom: 16 }}>
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        {step === 'company' && (
          <section>
            <h1 className="signup-title">Tell us about your company</h1>
            <p className="page-sub signup-lead">
              The workspace address is where your team will sign in.
            </p>
            <div className="settings-grid">
              <label className="setting">
                Company name *
                <input
                  value={company.name}
                  onChange={(e) => setCompanyField('name', e.target.value)}
                  placeholder="Acme Technologies"
                  autoFocus
                />
              </label>
              <label className="setting">
                Workspace address *
                <span className="slug-field">
                  <input
                    value={company.slug}
                    onChange={(e) => setCompanyField('slug', slugify(e.target.value))}
                    placeholder="acme"
                  />
                  <span className="slug-suffix">.{BASE_DOMAIN}</span>
                </span>
                {slugState && !slugState.available && (
                  <span className="setting-hint" style={{ color: 'var(--unprod)' }}>
                    {slugState.reason}
                    {slugState.suggestion && (
                      <>
                        {' '}
                        Try{' '}
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => setCompanyField('slug', slugState.suggestion!)}
                        >
                          {slugState.suggestion}
                        </button>
                      </>
                    )}
                  </span>
                )}
                {slugState?.available && (
                  <span className="setting-hint" style={{ color: 'var(--success-text)' }}>
                    {company.slug}.{BASE_DOMAIN} is available
                  </span>
                )}
              </label>
              <label className="setting">
                Billing email *
                <input
                  type="email"
                  value={company.contact_email}
                  onChange={(e) => setCompanyField('contact_email', e.target.value)}
                  placeholder="accounts@acme.com"
                />
              </label>
              <label className="setting">
                Phone
                <input
                  value={company.contact_phone}
                  onChange={(e) => setCompanyField('contact_phone', e.target.value)}
                  placeholder="+91 98200 00000"
                />
              </label>
              <label className="setting">
                City
                <input value={company.city} onChange={(e) => setCompanyField('city', e.target.value)} />
              </label>
              <label className="setting">
                State
                <input value={company.state} onChange={(e) => setCompanyField('state', e.target.value)} />
              </label>
              <label className="setting">
                GSTIN
                <input
                  value={company.gstin}
                  onChange={(e) => setCompanyField('gstin', e.target.value.toUpperCase())}
                  placeholder="27AAAAA0000A1Z5"
                />
                <span className="setting-hint">Optional. Appears on your invoices.</span>
              </label>
              <label className="setting">
                Time zone
                <input
                  value={company.timezone}
                  onChange={(e) => setCompanyField('timezone', e.target.value)}
                />
                <span className="setting-hint">Reporting days are cut in this zone.</span>
              </label>
            </div>
            <Nav
              onNext={() => setStep('admin')}
              nextDisabled={!companyValid}
              nextLabel="Continue"
            />
          </section>
        )}

        {step === 'admin' && (
          <section>
            <h1 className="signup-title">Create the administrator account</h1>
            <p className="page-sub signup-lead">
              This account owns the workspace and can add everyone else.
            </p>
            <div className="settings-grid">
              <label className="setting">
                Full name *
                <input
                  value={admin.full_name}
                  onChange={(e) => setAdmin({ ...admin, full_name: e.target.value })}
                  autoFocus
                />
              </label>
              <label className="setting">
                Work email *
                <input
                  type="email"
                  value={admin.email}
                  onChange={(e) => setAdmin({ ...admin, email: e.target.value })}
                />
                <span className="setting-hint">You will sign in with this.</span>
              </label>
              <label className="setting">
                Password *
                <input
                  type="password"
                  value={admin.password}
                  onChange={(e) => setAdmin({ ...admin, password: e.target.value })}
                />
                <span className="setting-hint">
                  {admin.password.length > 0 && admin.password.length < 10
                    ? `${10 - admin.password.length} more characters needed`
                    : 'At least 10 characters.'}
                </span>
              </label>
              <label className="setting">
                Phone
                <input value={admin.phone} onChange={(e) => setAdmin({ ...admin, phone: e.target.value })} />
              </label>
            </div>
            <Nav
              onBack={() => setStep('company')}
              onNext={() => setStep('plan')}
              nextDisabled={!adminValid}
              nextLabel="Choose a plan"
            />
          </section>
        )}

        {step === 'plan' && (
          <section>
            <h1 className="signup-title">Choose your plan</h1>
            <p className="page-sub signup-lead">
              The price is worked out for your team size, GST included, before you pay.
            </p>
            <div className="plan-grid">
              {plans.map((plan) => (
                <button
                  type="button"
                  key={plan.id}
                  className={`plan-card ${planId === plan.id ? 'plan-selected' : ''}`}
                  onClick={() => {
                    setPlanId(plan.id)
                    setEmployees((n) => Math.max(plan.min_employees, Math.min(n, plan.max_employees)))
                  }}
                >
                  <div className="plan-name">{plan.name}</div>
                  {plan.description && <div className="plan-desc">{plan.description}</div>}
                  <div className="plan-price">
                    {plan.base_price_annual === 0 ? (
                      'Free'
                    ) : (
                      <>
                        {rupees(plan.base_price_annual)}
                        <span className="plan-per"> / year</span>
                      </>
                    )}
                  </div>
                  {plan.per_employee_month > 0 && (
                    <div className="plan-per">
                      + {rupees(plan.per_employee_month)} per employee / month
                    </div>
                  )}
                  <ul className="plan-features">
                    {plan.features.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </button>
              ))}
            </div>

            {planId !== 'trial' && (
              <div className="settings-grid" style={{ marginTop: 20 }}>
                <label className="setting">
                  Number of employees
                  <input
                    type="number"
                    min={selectedPlan?.min_employees ?? 1}
                    max={selectedPlan?.max_employees ?? 1000}
                    value={employees}
                    onChange={(e) => setEmployees(Math.max(1, Number(e.target.value) || 1))}
                  />
                  <span className="setting-hint">
                    You can add more later; billing adjusts at renewal.
                  </span>
                </label>
                <label className="setting">
                  Billing cycle
                  <select value={cycle} onChange={(e) => setCycle(e.target.value)}>
                    <option value="annual">Annual</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </label>
              </div>
            )}

            {quote && (
              <div className="quote-box">
                <div className="quote-row">
                  <span>Base ({quote.billing_cycle})</span>
                  <b>{rupees(quote.base_amount)}</b>
                </div>
                <div className="quote-row">
                  <span>
                    {quote.employees} employees × {rupees(quote.per_employee_month)} ×{' '}
                    {quote.billing_cycle === 'annual' ? 12 : 1} month
                    {quote.billing_cycle === 'annual' ? 's' : ''}
                  </span>
                  <b>{rupees(quote.seat_amount)}</b>
                </div>
                <div className="quote-row">
                  <span>GST ({quote.tax_rate_pct}%)</span>
                  <b>{rupees(quote.tax_amount)}</b>
                </div>
                <div className="quote-row quote-total">
                  <span>Total due today</span>
                  <b>{quote.total_display}</b>
                </div>
              </div>
            )}

            <Nav
              onBack={() => setStep('admin')}
              onNext={() => setStep('pay')}
              nextLabel="Review"
            />
          </section>
        )}

        {step === 'pay' && (
          <section>
            <h1 className="signup-title">Review and confirm</h1>
            <p className="page-sub signup-lead">Check the details once before the workspace is created.</p>
            <dl className="review">
              <div><dt>Company</dt><dd>{company.name}</dd></div>
              <div><dt>Workspace</dt><dd>{company.slug}.{BASE_DOMAIN}</dd></div>
              <div><dt>Administrator</dt><dd>{admin.full_name} · {admin.email}</dd></div>
              <div><dt>Plan</dt><dd>{selectedPlan?.name ?? planId}</dd></div>
              {planId !== 'trial' && (
                <>
                  <div><dt>Employees</dt><dd>{employees}</dd></div>
                  <div><dt>Billing</dt><dd>{cycle}</dd></div>
                  <div className="review-total">
                    <dt>Total</dt>
                    <dd>{quote ? quote.total_display : '—'} <span>incl. GST</span></dd>
                  </div>
                </>
              )}
            </dl>

            <label className="switch-row" style={{ margin: '18px 0' }}>
              <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
              <span>
                I accept the terms of service, and confirm that employees will be notified that
                their activity is monitored.
              </span>
            </label>

            <Nav
              onBack={() => setStep('plan')}
              onNext={submit}
              nextDisabled={!terms || busy}
              nextLabel={
                busy
                  ? 'Working…'
                  : planId === 'trial'
                    ? 'Start free trial'
                    : `Pay ${quote?.total_display ?? ''}`
              }
            />
          </section>
        )}

        <div className="auth-divider">Already have a workspace?</div>
        <p className="auth-alt"><a href={loginHref()}>Sign in to your account →</a></p>
      </div>
    </AuthShell>
  )
}

function Nav({
  onBack,
  onNext,
  nextDisabled,
  nextLabel,
}: {
  onBack?: () => void
  onNext: () => void
  nextDisabled?: boolean
  nextLabel: string
}) {
  return (
    <div className="signup-nav">
      {onBack ? (
        <button type="button" className="btn" onClick={onBack}>
          Back
        </button>
      ) : (
        <span />
      )}
      <button type="button" className="btn btn-primary" onClick={onNext} disabled={nextDisabled}>
        {nextLabel}
      </button>
    </div>
  )
}

function Done({ complete }: { complete: SignupComplete }) {
  return (
    <AuthShell wide>
      <div className="signup-card" style={{ textAlign: 'center' }}>
        <div className="done-tick">✓</div>
        <h1 className="signup-title">Your workspace is ready</h1>
        <p className="page-sub">
          {complete.plan_name} · {complete.seats} seats
          {complete.period_end && ` · active until ${complete.period_end.slice(0, 10)}`}
        </p>
        <div className="quote-box" style={{ textAlign: 'left' }}>
          <div className="quote-row">
            <span>Workspace</span>
            <b>{complete.slug}.{BASE_DOMAIN}</b>
          </div>
          <div className="quote-row">
            <span>Administrator</span>
            <b>{complete.admin_email}</b>
          </div>
        </div>
        <a className="btn btn-primary" style={{ display: 'inline-block', marginTop: 20 }}
           href={complete.login_url}>
          Sign in to your dashboard
        </a>
        <p className="setting-hint" style={{ marginTop: 16 }}>
          Next: add employees, then install the desktop agent on their machines.
        </p>
      </div>
    </AuthShell>
  )
}
