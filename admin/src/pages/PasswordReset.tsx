/**
 * Forgot password, and the page its email links to.
 *
 * Two steps on the server (see api/v1/auth.py): ask for a link, then use it.
 * The link is single-use and expires, and the request answers the same for an
 * address that does not exist — so this page never says "no such account".
 */
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import AuthShell, { EyeIcon } from '../components/AuthShell'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { BASE_DOMAIN, getSlug, setSlug, slugFromHostname } from '../lib/tenant'

const MailIcon = () => (
  <svg className="auth-input-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3.5 7l8.5 6 8.5-6" />
  </svg>
)
const LockIcon = () => (
  <svg className="auth-input-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" />
  </svg>
)
const BuildingIcon = () => (
  <svg className="auth-input-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1" />
  </svg>
)

function StatusMark({ tone }: { tone: 'ok' | 'bad' | 'mail' }) {
  return (
    <span className={`auth-mark is-${tone}`} aria-hidden>
      {tone === 'ok' ? (
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.2 4L19 7" /></svg>
      ) : tone === 'bad' ? (
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 7v6M12 17h.01" /><circle cx="12" cy="12" r="9" /></svg>
      ) : (
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3.5 7l8.5 6 8.5-6" /></svg>
      )}
    </span>
  )
}

/* ------------------------------------------------------- forgot password --- */

export function ForgotPassword() {
  const { organization } = useAuth()
  const [params] = useSearchParams()
  const fromHost = slugFromHostname()
  const [org, setOrg] = useState(getSlug() ?? '')
  const [email, setEmail] = useState(params.get('email') ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<{ email: string; devUrl: string | null } | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      // Where the address does not name the workspace, the request has to.
      if (!fromHost) setSlug(org.trim().toLowerCase())
      const out = await api.post<{ ok: boolean; dev_reset_url: string | null }>(
        '/auth/forgot-password', { email: email.trim() },
      )
      setSent({ email: email.trim(), devUrl: out.dev_reset_url })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the reset link')
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <AuthShell>
        <StatusMark tone="mail" />
        <h1 className="auth-title">Check your email</h1>
        <p className="auth-sub">
          If <strong>{sent.email}</strong> has an account
          {organization ? ` at ${organization.name}` : ''}, a link to reset the password is on
          its way. It works once and expires in 2 hours.
        </p>
        {sent.devUrl && (
          <div className="auth-dev">
            <span>Mail is not set up on this server, so here is the link directly (development only):</span>
            <a href={sent.devUrl}>Open the reset link →</a>
          </div>
        )}
        <div className="auth-actions">
          <Link to="/login" className="auth-submit auth-submit-link">Back to sign in</Link>
          <button type="button" className="auth-link" onClick={() => setSent(null)}>
            Didn’t get it? Send again
          </button>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <h1 className="auth-title">Forgot your password?</h1>
      <p className="auth-sub">
        Enter your work email and we’ll send you a link to choose a new one.
      </p>

      <form className="auth-form" onSubmit={submit}>
        {error && <div className="auth-error" role="alert">{error}</div>}

        {!fromHost && (
          <label className="auth-field">
            <span className="auth-field-label">Workspace</span>
            <span className="auth-input has-addon">
              <BuildingIcon />
              <input type="text" autoComplete="organization" value={org} required
                     onChange={(e) => setOrg(e.target.value)} placeholder="your-company" />
              <span className="auth-input-addon">.{BASE_DOMAIN}</span>
            </span>
          </label>
        )}

        <label className="auth-field">
          <span className="auth-field-label">Work email</span>
          <span className="auth-input">
            <MailIcon />
            <input type="email" autoComplete="username" value={email} required autoFocus
                   onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </span>
        </label>

        <button className="auth-submit" disabled={busy}>
          {busy && <span className="auth-spinner" aria-hidden />}
          {busy ? 'Sending…' : 'Send reset link'}
        </button>
      </form>

      <p className="auth-alt auth-back">
        <Link to="/login">← Back to sign in</Link>
      </p>
    </AuthShell>
  )
}

/* -------------------------------------------------------- reset password --- */

function strength(pw: string): { score: number; label: string } {
  let score = 0
  if (pw.length >= 8) score++
  if (pw.length >= 12) score++
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++
  if (/\d/.test(pw)) score++
  if (/[^A-Za-z0-9]/.test(pw)) score++
  const label = pw.length < 8 ? 'Too short' : score <= 2 ? 'Weak' : score === 3 ? 'Good' : 'Strong'
  return { score: Math.min(score, 4), label }
}

export function ResetPassword() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [who, setWho] = useState<{ email: string; name: string } | null>(null)
  const [linkError, setLinkError] = useState<string | null>(token ? null : 'This reset link is incomplete.')
  const [checking, setChecking] = useState(Boolean(token))
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!token) return
    api.get<{ email: string; name: string }>(`/auth/reset-password?token=${encodeURIComponent(token)}`)
      .then(setWho)
      .catch((err) => setLinkError(err instanceof Error ? err.message : 'This reset link is not valid.'))
      .finally(() => setChecking(false))
  }, [token])

  const s = strength(password)
  const mismatch = confirm.length > 0 && confirm !== password
  const canSave = password.length >= 8 && password === confirm && !busy

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      await api.post('/auth/reset-password', { token, password })
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the new password')
    } finally {
      setBusy(false)
    }
  }

  if (checking) {
    return (
      <AuthShell>
        <p className="auth-sub"><span className="auth-spinner is-dark" aria-hidden /> Checking your link…</p>
      </AuthShell>
    )
  }

  if (linkError) {
    return (
      <AuthShell>
        <StatusMark tone="bad" />
        <h1 className="auth-title">This link can’t be used</h1>
        <p className="auth-sub">{linkError}</p>
        <div className="auth-actions">
          <Link to="/forgot-password" className="auth-submit auth-submit-link">Request a new link</Link>
          <Link to="/login" className="auth-link">Back to sign in</Link>
        </div>
      </AuthShell>
    )
  }

  if (done) {
    return (
      <AuthShell>
        <StatusMark tone="ok" />
        <h1 className="auth-title">Password updated</h1>
        <p className="auth-sub">
          You can now sign in{who ? <> as <strong>{who.email}</strong></> : null} with your new password.
        </p>
        <div className="auth-actions">
          <Link to="/login" className="auth-submit auth-submit-link">Sign in</Link>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <h1 className="auth-title">Set a new password</h1>
      <p className="auth-sub">
        {who ? <>For <strong>{who.email}</strong>. </> : null}
        Use at least 8 characters — a mix of letters, numbers and a symbol is best.
      </p>

      <form className="auth-form" onSubmit={submit}>
        {error && <div className="auth-error" role="alert">{error}</div>}

        <div className="auth-field">
          <label className="auth-field-label" htmlFor="new-password">New password</label>
          <span className="auth-input">
            <LockIcon />
            <input id="new-password" type={show ? 'text' : 'password'} autoComplete="new-password"
                   value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus
                   placeholder="At least 8 characters" />
            <button type="button" className="auth-input-suffix" onClick={() => setShow((v) => !v)}
                    aria-label={show ? 'Hide password' : 'Show password'}>
              <EyeIcon open={!show} />
            </button>
          </span>
          {password && (
            <div className={`auth-strength is-${s.score}`} aria-live="polite">
              <span className="auth-strength-bar"><span style={{ width: `${(s.score / 4) * 100}%` }} /></span>
              <span className="auth-strength-label">{s.label}</span>
            </div>
          )}
        </div>

        <div className="auth-field">
          <label className="auth-field-label" htmlFor="confirm-password">Confirm new password</label>
          <span className={`auth-input${mismatch ? ' is-bad' : ''}`}>
            <LockIcon />
            <input id="confirm-password" type={show ? 'text' : 'password'} autoComplete="new-password"
                   value={confirm} onChange={(e) => setConfirm(e.target.value)} required
                   placeholder="Type it again" />
          </span>
          {mismatch && <span className="auth-field-error">The two passwords don’t match.</span>}
        </div>

        <button className="auth-submit" disabled={!canSave}>
          {busy && <span className="auth-spinner" aria-hidden />}
          {busy ? 'Saving…' : 'Update password'}
        </button>
      </form>

      <p className="auth-alt auth-back">
        <Link to="/login">← Back to sign in</Link>
      </p>
    </AuthShell>
  )
}
