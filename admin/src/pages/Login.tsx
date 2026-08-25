import { useState, type FormEvent } from 'react'
// Shares .signup-foot with the wizard; Vite dedupes the import.
import '../styles/signup.css'
import { useAuth } from '../lib/auth'
import Brand from '../components/Brand'
import { ErrorNote } from '../components/ui'
import { BASE_DOMAIN, getSlug, slugFromHostname } from '../lib/tenant'

export default function Login() {
  const { login, organization } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [org, setOrg] = useState(getSlug() ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // With a tenant subdomain there is nothing to choose, so the field is not
  // shown. Without one — plain localhost, or a bare apex domain — sign-in has
  // to know which organisation to check the password against.
  const fromHost = slugFromHostname()

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

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={onSubmit}>
        <Brand size={36} />
        <p className="page-sub" style={{ marginTop: 0, marginBottom: 20, textAlign: 'center' }}>
          {organization
            ? `Sign in to ${organization.name}.`
            : 'Sign in to the workforce analytics console.'}
        </p>

        {error && (
          <div style={{ marginBottom: 16 }}>
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        {!fromHost && (
          <label>
            Organisation
            <input
              type="text"
              autoComplete="organization"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              placeholder="acme"
              required
            />
            <span className="setting-hint">
              Your workspace name. In production this comes from the address —
              <code> acme.{BASE_DOMAIN}</code> — and this field disappears.
            </span>
          </label>
        )}

        <label>
          Work email
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="signup-foot">
          New company? <a href={signupUrl}>Create a workspace</a>
        </p>
      </form>
    </div>
  )
}
