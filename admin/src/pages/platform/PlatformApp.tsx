import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import '../../styles/platform.css'
import { BrandMark } from '../../components/Brand'
import { ErrorNote } from '../../components/ui'
import {
  getPlatformToken,
  platformApi,
  setPlatformToken,
  type PlatformAdmin,
} from '../../lib/platformApi'
import PlatformCompanies from './PlatformCompanies'
import PlatformMail from './PlatformMail'
import PlatformOverview from './PlatformOverview'
import PlatformPlans from './PlatformPlans'
import PlatformAudit from './PlatformAudit'
import PlatformCompany from './PlatformCompany'

/**
 * The Super Admin console.
 *
 * Mounted at /platform/* and gated by its own credentials, entirely separate
 * from the company console's auth. Visually distinct too — a deliberately
 * darker chrome, because an operator with a company dashboard open in the next
 * tab must never be in doubt about which system they are acting on.
 */
export default function PlatformApp() {
  const [admin, setAdmin] = useState<PlatformAdmin | null>(null)
  const [ready, setReady] = useState(false)
  const location = useLocation()

  const refresh = useCallback(async () => {
    if (!getPlatformToken()) {
      setReady(true)
      return
    }
    try {
      setAdmin(await platformApi.me())
    } catch {
      setPlatformToken(null)
    } finally {
      setReady(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!ready) return null

  if (!admin) {
    return (
      <Routes>
        <Route path="/platform/login" element={<PlatformLogin onSignedIn={setAdmin} />} />
        <Route path="*" element={<Navigate to="/platform/login" replace />} />
      </Routes>
    )
  }

  // The bootstrap password grants read access only; the API refuses every
  // write. Sending the operator straight here makes that obvious rather than
  // letting them discover it through a 403 on their first action.
  if (admin.must_change_password) {
    return <ForcePasswordChange admin={admin} onDone={setAdmin} />
  }

  if (location.pathname === '/platform/login') return <Navigate to="/platform" replace />

  return (
    <div className="pf-shell">
      {/* The rail is a plain flex child so it spans the shell's full height; the
          sticky, visible card is the inner wrapper. Same structure as the
          company console's sidebar, for the same reason. */}
      <nav className="pf-sidebar">
       <div className="pf-sidebar-inner">
        <div className="pf-brand">
          <BrandMark size={26} />
          <div>
            <div className="pf-brand-tag">Platform console</div>
          </div>
        </div>

        {/* Grouped like the company console's rail. A flat list ending in one
            link pushed to the bottom read as an accident rather than a
            category. */}
        <NavLink to="/platform" end className="pf-nav-link">
          Overview
        </NavLink>

        <div className="pf-nav-group">Customers</div>
        <NavLink to="/platform/companies" className="pf-nav-link">
          Companies
        </NavLink>
        <NavLink to="/platform/plans" className="pf-nav-link">
          Plans
        </NavLink>

        <div className="pf-nav-group">Platform</div>
        <NavLink to="/platform/audit" className="pf-nav-link">
          Activity log
        </NavLink>
        <NavLink to="/platform/mail" className="pf-nav-link">
          Email connector
        </NavLink>

        <div className="pf-sidebar-foot">
          <div>
            <div className="pf-admin-name">{admin.full_name}</div>
            <div>{admin.email}</div>
          </div>
          <button
            className="btn btn-sm"
            onClick={() => {
              setPlatformToken(null)
              setAdmin(null)
            }}
          >
            Sign out
          </button>
        </div>
       </div>
      </nav>

      <main className="pf-main">
        <Routes>
          <Route path="/platform" element={<PlatformOverview />} />
          <Route path="/platform/companies" element={<PlatformCompanies />} />
          <Route path="/platform/plans" element={<PlatformPlans />} />
          <Route path="/platform/audit" element={<PlatformAudit />} />
          <Route path="/platform/mail" element={<PlatformMail />} />
          <Route path="/platform/companies/:orgId" element={<PlatformCompany />} />
          <Route path="*" element={<Navigate to="/platform" replace />} />
        </Routes>
      </main>
    </div>
  )
}

function PlatformLogin({ onSignedIn }: { onSignedIn: (admin: PlatformAdmin) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await platformApi.login(email.trim(), password)
      setPlatformToken(result.access_token)
      onSignedIn(result.admin)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pf-login-wrap">
      <form className="pf-login-card" onSubmit={submit}>
        <div className="pf-brand" style={{ justifyContent: 'center', paddingBottom: 18 }}>
          <BrandMark size={30} />
          <div>
            <div className="pf-brand-word">MyDeskTime</div>
            <div className="pf-brand-tag">Platform console</div>
          </div>
        </div>

        {error && (
          <div style={{ marginBottom: 14 }}>
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        <label>
          Operator email
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
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
        <p className="pf-login-note">
          This console manages every customer on the platform. It is not the company dashboard.
        </p>
      </form>
    </div>
  )
}

function ForcePasswordChange({
  admin,
  onDone,
}: {
  admin: PlatformAdmin
  onDone: (admin: PlatformAdmin) => void
}) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const mismatch = confirm.length > 0 && next !== confirm

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (mismatch) return
    setBusy(true)
    setError(null)
    try {
      onDone(await platformApi.changePassword(current, next))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pf-login-wrap">
      <form className="pf-login-card" onSubmit={submit}>
        <h1 className="pf-title" style={{ marginTop: 0 }}>Choose a new password</h1>
        <p className="pf-sub">
          {admin.email} is still on its bootstrap password. Every change is blocked until it is
          replaced.
        </p>

        {error && (
          <div style={{ margin: '14px 0' }}>
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        <label>
          Current password
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label>
          New password
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            minLength={12}
            required
          />
          <span className="pf-hint">At least 12 characters.</span>
        </label>
        <label>
          Confirm new password
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
          {mismatch && <span className="pf-hint pf-danger">The passwords do not match.</span>}
        </label>

        <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy || mismatch}>
          {busy ? 'Saving…' : 'Set password'}
        </button>
      </form>
    </div>
  )
}
