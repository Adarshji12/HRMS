import { useEffect, useState, type FormEvent } from 'react'
import '../styles/org.css'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { useAuth } from '../lib/auth'
import { dateTime } from '../lib/format'
import { ErrorNote, Loading } from '../components/ui'
import { IconAlert, IconCheck } from '../components/Icons'

/**
 * This workspace's own outbound mail.
 *
 * Owner-only, not admin-only. An administrator runs the workspace day to day;
 * "who may send mail as this company" is the account holder's decision and it
 * carries a third-party credential.
 *
 * Leaving it blank is a valid, supported answer — mail then leaves through the
 * platform's connector. The screen has to say so, because a blank form that is
 * quietly working looks identical to a blank form that is quietly broken.
 */

interface MailState {
  smtp_host: string
  smtp_port: number
  smtp_user: string
  smtp_use_tls: boolean
  email_from: string
  has_password: boolean
  effective_source: 'workspace' | 'platform' | 'none'
  effective_host: string
  configured: boolean
  last_test: { at: string | null; to: string | null; ok: boolean | null; error: string | null }
}

export default function EmailSetup() {
  const { organization } = useAuth()
  const { data, error, loading, reload } = useQuery<MailState>('org-mail', () =>
    api.get<MailState>('/admin/mail'),
  )

  const [form, setForm] = useState({
    smtp_host: '', smtp_port: 587, smtp_user: '', smtp_use_tls: true, email_from: '',
  })
  // undefined = leave the stored password alone. Only a deliberate edit sends a
  // value, so saving the host cannot silently wipe the credential.
  const [password, setPassword] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [testTo, setTestTo] = useState('')
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    if (!data) return
    setForm({
      smtp_host: data.smtp_host,
      smtp_port: data.smtp_port,
      smtp_user: data.smtp_user,
      smtp_use_tls: data.smtp_use_tls,
      email_from: data.email_from,
    })
    setPassword(undefined)
  }, [data])

  if (error) return <ErrorNote>{error}</ErrorNote>
  if (loading || !data) return <Loading />

  async function save(event: FormEvent) {
    event.preventDefault()
    setSaving(true); setFormError(null)
    try {
      await api.put('/admin/mail', {
        ...form,
        ...(password === undefined ? {} : { smtp_password: password }),
      })
      setSaved(true); reload()
      window.setTimeout(() => setSaved(false), 2500)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save')
    } finally { setSaving(false) }
  }

  async function sendTest() {
    setTesting(true); setFormError(null)
    try {
      await api.post('/admin/mail/test', { to: testTo.trim() })
      reload()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not send')
    } finally { setTesting(false) }
  }

  const test = data.last_test
  const usingPlatform = data.effective_source === 'platform'

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Email setup</h1>
          <p className="page-sub">
            The mail server {organization?.name ?? 'this workspace'} sends from — timesheet
            decisions, alerts, invitations and password resets. Only you can change this.
          </p>
        </div>
      </div>

      <div
        className={`notice${data.configured ? (usingPlatform ? '' : '') : ' notice-warn'}`}
        style={{ marginBottom: 16 }}
      >
        {data.configured ? <IconCheck size={15} /> : <IconAlert size={15} />}{' '}
        {data.effective_source === 'workspace' && (
          <>
            <b>Sending through your own server — {data.effective_host}.</b> Staff receive
            mail from your domain.
          </>
        )}
        {usingPlatform && (
          <>
            <b>Using the platform's shared mail server.</b> This works, and you can leave
            it as is. Set your own below if you would rather mail reached your staff from
            your own domain.
          </>
        )}
        {data.effective_source === 'none' && (
          <>
            <b>No mail server available.</b> Nothing is being delivered — alerts and
            password resets are written to the server log instead. Set one below, or ask
            your provider to configure the platform default.
          </>
        )}
      </div>

      {formError && <ErrorNote>{formError}</ErrorNote>}

      <form onSubmit={save}>
        <section className="card" style={{ marginBottom: 14 }}>
          <div className="card-head">
            <h2 className="card-title">Your SMTP server</h2>
            {saved && <span className="card-note">Saved</span>}
          </div>

          <div className="settings-grid">
            <label className="setting">
              Host
              <input
                value={form.smtp_host}
                onChange={(e) => setForm({ ...form, smtp_host: e.target.value })}
                placeholder="smtp.office365.com"
                autoComplete="off"
              />
              <span className="setting-hint">
                Leave blank to keep using the platform's shared server.
              </span>
            </label>
            <label className="setting">
              Port
              <input
                type="number" min={1} max={65535} value={form.smtp_port}
                onChange={(e) => setForm({ ...form, smtp_port: Number(e.target.value) })}
              />
              <span className="setting-hint">587 for STARTTLS, 465 for implicit TLS.</span>
            </label>
            <label className="setting">
              Username
              <input
                value={form.smtp_user}
                onChange={(e) => setForm({ ...form, smtp_user: e.target.value })}
                placeholder="alerts@yourcompany.com"
                autoComplete="off"
              />
            </label>
            <label className="setting">
              Password
              <input
                type="password"
                value={password ?? ''}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={data.has_password ? '•••••••• (unchanged)' : 'not set'}
                autoComplete="new-password"
              />
              <span className="setting-hint">
                Stored encrypted and never shown again. Leave untouched to keep it.
              </span>
            </label>
            <label className="setting">
              From address
              <input
                value={form.email_from}
                onChange={(e) => setForm({ ...form, email_from: e.target.value })}
                placeholder={`${organization?.name ?? 'Your company'} <alerts@yourcompany.com>`}
              />
              <span className="setting-hint">
                Must be an address your provider lets you send from, or messages bounce.
              </span>
            </label>
          </div>

          <label className="switch-row" style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={form.smtp_use_tls}
              disabled={form.smtp_port === 465}
              onChange={(e) => setForm({ ...form, smtp_use_tls: e.target.checked })}
            />
            <span>
              Use STARTTLS
              {form.smtp_port === 465 && ' — ignored on port 465, which is TLS from the start'}
            </span>
          </label>

          <div style={{ marginTop: 16 }}>
            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </section>
      </form>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Send a test message</h2>
          <span className="card-note">saving only proves the form was valid</span>
        </div>
        <div className="filter-row" style={{ marginBottom: 0 }}>
          <input
            type="email" value={testTo} placeholder="you@yourcompany.com"
            onChange={(e) => setTestTo(e.target.value)} style={{ minWidth: 260 }}
          />
          <button
            className="btn" onClick={sendTest}
            disabled={testing || !testTo.trim() || !data.configured}
          >
            {testing ? 'Sending…' : 'Send test'}
          </button>
        </div>
        {test.at && (
          <div className={`test-result ${test.ok ? 'test-ok' : 'test-bad'}`}>
            {test.ok ? <IconCheck size={15} /> : <IconAlert size={15} />}
            <div>
              <b>{test.ok ? 'Delivered' : 'Failed'}</b> to {test.to} · {dateTime(test.at)}
              {test.error && <div className="test-error">{test.error}</div>}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
