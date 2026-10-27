import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { ApiError } from '../lib/api'
import AuthShell, { EyeIcon } from '../components/AuthShell'
import { BASE_DOMAIN, slugFromHostname } from '../lib/tenant'

type Workspace = { slug: string; name: string }

export default function Login() {
  const { login, organization } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Filled only when one email and password open accounts in several companies.
  const [choices, setChoices] = useState<Workspace[] | null>(null)

  // Only email and password are asked for. On a tenant subdomain the company
  // is the address; anywhere else the server finds it from the account.
  const fromHost = slugFromHostname()

  // Signup belongs to the marketing host, not a tenant's. Linking to /signup
  // from acme.example.com would start a new company inside Acme's address bar.
  const signupUrl = fromHost
    ? `${window.location.protocol}//${BASE_DOMAIN}${
        window.location.port ? `:${window.location.port}` : ''
      }/signup?from=${encodeURIComponent(fromHost)}`
    : '/signup'

  async function signIn(slug?: string) {
    setBusy(true)
    setError(null)
    try {
      await login(email.trim(), password, fromHost ?? slug)
    } catch (err) {
      if (err instanceof ApiError && err.reason === 'choose_workspace') {
        setChoices((err.detail?.workspaces as Workspace[] | undefined) ?? [])
      } else {
        setChoices(null)
        setError(err instanceof Error ? err.message : 'Sign-in failed')
      }
    } finally {
      setBusy(false)
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    void signIn()
  }

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

        {choices && (
          <div className="auth-field">
            <span className="auth-field-label">This account is in more than one company</span>
            {choices.map((workspace) => (
              <button
                key={workspace.slug}
                type="button"
                className="auth-workspace"
                onClick={() => void signIn(workspace.slug)}
                disabled={busy}
              >
                <strong>{workspace.name}</strong>
                <span>{workspace.slug}.{BASE_DOMAIN}</span>
              </button>
            ))}
          </div>
        )}

        <label className="auth-field">
          <span className="auth-field-label">Work email</span>
          <span className="auth-input">
            <svg className="auth-input-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3.5 7l8.5 6 8.5-6" /></svg>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setChoices(null) }}
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
              onChange={(e) => { setPassword(e.target.value); setChoices(null) }}
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
