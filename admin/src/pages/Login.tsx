import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import AuthShell, { EyeIcon } from '../components/AuthShell'
import { BASE_DOMAIN, getSlug, slugFromHostname, tenantUrl } from '../lib/tenant'

export default function Login() {
  const { login, organization } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [org, setOrg] = useState(getSlug() ?? '')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // With a tenant subdomain there is nothing to choose, so the field is not
  // shown. Without one — plain localhost, or a bare apex domain — sign-in has
  // to know which organisation to check the password against.
  const fromHost = slugFromHostname()

  /* On the bare domain the workspace has to be typed — unless this browser has
     signed in to one before. Then it goes straight to that workspace's own
     address, so there is one sign-in page: email and password, nothing else.
     A first-time visitor still gets the field. */
  // Read once, on arrival: signing in here saves the workspace too, and that
  // must not then bounce the person who just signed in to a second login.
  const [remembered] = useState(() => (fromHost ? null : getSlug()))
  useEffect(() => {
    if (remembered) window.location.replace(`${tenantUrl(remembered)}/login`)
  }, [remembered])

  // Signup belongs to the marketing host, not a tenant's. Linking to /signup
  // from acme.example.com would start a new company inside Acme's address bar.
  const signupUrl = fromHost
    ? `${window.location.protocol}//${BASE_DOMAIN}${
        window.location.port ? `:${window.location.port}` : ''
      }/signup`
    : '/signup'

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(email.trim(), password, fromHost ?? org.trim().toLowerCase())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  // On its way to the workspace's own page — nothing to show meanwhile.
  if (remembered) return null

  return (
    <AuthShell>
      <h1 className="auth-title">Sign in to your account</h1>
      <p className="auth-sub">
        {organization
          ? `Sign in to ${organization.name} to continue to your workspace.`
          : 'Sign in to your workspace to manage people, payroll and operations.'}
      </p>

      <form className="auth-form" onSubmit={onSubmit} noValidate={false}>
        {error && <div className="auth-error" role="alert">{error}</div>}

        {!fromHost && (
          <label className="auth-field">
            <span className="auth-field-label">Workspace</span>
            <span className="auth-input has-addon">
              <svg className="auth-input-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1" /></svg>
              <input
                type="text"
                autoComplete="organization"
                value={org}
                onChange={(e) => setOrg(e.target.value)}
                placeholder="your-company"
                required
              />
              <span className="auth-input-addon">.{BASE_DOMAIN}</span>
            </span>
          </label>
        )}

        <label className="auth-field">
          <span className="auth-field-label">Work email</span>
          <span className="auth-input">
            <svg className="auth-input-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3.5 7l8.5 6 8.5-6" /></svg>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
              autoFocus
            />
          </span>
        </label>

        <div className="auth-field">
          <span className="auth-field-label">
            <label htmlFor="login-password">Password</label>
            <Link className="auth-link"
                  to={`/forgot-password${email.trim() ? `?email=${encodeURIComponent(email.trim())}` : ''}`}>
              Forgot password?
            </Link>
          </span>
          <span className="auth-input">
            <svg className="auth-input-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg>
            <input
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
            />
            <button
              type="button"
              className="auth-input-suffix"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              <EyeIcon open={!showPassword} />
            </button>
          </span>
        </div>

        <button className="auth-submit" disabled={busy}>
          {busy && <span className="auth-spinner" aria-hidden />}
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <div className="auth-divider">New to the platform?</div>
      <p className="auth-alt">
        <a href={signupUrl}>Create a workspace for your company →</a>
      </p>
    </AuthShell>
  )
}
