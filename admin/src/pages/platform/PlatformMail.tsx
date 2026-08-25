import { useEffect, useState, type FormEvent } from 'react'
import { platformApi, type MailState } from '../../lib/platformApi'
import { useQuery } from '../../lib/useQuery'
import { dateTime } from '../../lib/format'
import { ErrorNote, Loading } from '../../components/ui'
import { IconAlert, IconCheck } from '../../components/Icons'

/**
 * The outbound mail connector — the only place SMTP is configured.
 *
 * Platform-level rather than per-company, because every message this product
 * sends is MyDeskTime-branded and goes to an address the platform already
 * knows. Letting each tenant paste its own SMTP credentials would mean holding
 * a few hundred third-party passwords to solve a white-labelling problem nobody
 * has asked for.
 *
 * There is no environment fallback behind this screen. Two places to configure
 * one thing means every "why is mail not sending" starts with working out which
 * one won.
 */

export default function PlatformMail() {
  const { data, error, loading, reload } = useQuery<MailState>('platform-mail', () =>
    platformApi.mail(),
  )

  const [form, setForm] = useState({
    smtp_host: '', smtp_port: 587, smtp_user: '', smtp_use_tls: true, email_from: '',
  })
  // Undefined means "leave the stored password alone". Only a deliberate edit
  // sends a value, so saving the host does not silently wipe the credential.
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
    // Back to "unchanged" after every load, so a save that follows a reload
    // cannot resend a stale value from the box.
    setPassword(undefined)
  }, [data])

  if (error) return <ErrorNote>{error}</ErrorNote>
  if (loading || !data) return <Loading />

  async function save(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setFormError(null)
    try {
      await platformApi.saveMail({
        ...form,
        ...(password === undefined ? {} : { smtp_password: password }),
      })
      setSaved(true)
      reload()
      window.setTimeout(() => setSaved(false), 2500)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  async function sendTest() {
    setTesting(true)
    setFormError(null)
    try {
      await platformApi.testMail(testTo.trim())
      reload()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not send')
    } finally {
      setTesting(false)
    }
  }

  const test = data.last_test

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Email connector</h1>
          <p className="page-sub">
            One SMTP server for the whole platform — signup, invitations, password resets
            and every alert. Configured here and nowhere else; changes take effect
            immediately, with no restart.
          </p>
        </div>
      </div>

      <div className={`notice${data.configured ? '' : ' notice-warn'}`} style={{ marginBottom: 16 }}>
        {data.configured ? <IconCheck size={15} /> : <IconAlert size={15} />}{' '}
        {data.configured ? (
          <>
            <b>Connected — {data.smtp_host}:{data.smtp_port}</b> Every message the
            platform sends goes through this server.
          </>
        ) : (
          <>
            <b>Not configured.</b> Nothing is being delivered — signup, password
            resets and alerts are written to the server log instead.
          </>
        )}
      </div>

      {formError && <ErrorNote>{formError}</ErrorNote>}

      <form onSubmit={save}>
        <section className="card" style={{ marginBottom: 14 }}>
          <div className="card-head">
            <h2 className="card-title">SMTP server</h2>
            {saved && <span className="card-note">Saved</span>}
          </div>

          <div className="settings-grid">
            <label className="setting">
              Host
              <input
                value={form.smtp_host}
                onChange={(e) => setForm({ ...form, smtp_host: e.target.value })}
                placeholder="smtp.sendgrid.net"
                autoComplete="off"
              />
              <span className="setting-hint">
                Your provider's outgoing server, e.g. smtp.gmail.com or smtp.sendgrid.net.
              </span>
            </label>
            <label className="setting">
              Port
              <input
                type="number"
                value={form.smtp_port}
                min={1}
                max={65535}
                onChange={(e) => setForm({ ...form, smtp_port: Number(e.target.value) })}
              />
              <span className="setting-hint">
                587 for STARTTLS, 465 for implicit TLS, 25 for an unauthenticated relay.
              </span>
            </label>
            <label className="setting">
              Username
              <input
                value={form.smtp_user}
                onChange={(e) => setForm({ ...form, smtp_user: e.target.value })}
                placeholder="apikey"
                autoComplete="off"
              />
              <span className="setting-hint">Leave blank for a relay that does not authenticate.</span>
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
                {/* Never sent back to the browser, so the field cannot show it. */}
                Stored encrypted. Leave untouched to keep the current password.
              </span>
            </label>
            <label className="setting">
              From address
              <input
                value={form.email_from}
                onChange={(e) => setForm({ ...form, email_from: e.target.value })}
                placeholder="MyDeskTime <no-reply@yourdomain.com>"
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
              onChange={(e) => setForm({ ...form, smtp_use_tls: e.target.checked })}
              disabled={form.smtp_port === 465}
            />
            <span>
              Use STARTTLS
              {form.smtp_port === 465 && ' — ignored on port 465, which is TLS from the start'}
            </span>
          </label>

          <div style={{ marginTop: 16 }}>
            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save connector'}
            </button>
          </div>
        </section>
      </form>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Send a test message</h2>
          <span className="card-note">saving only proves the form was valid</span>
        </div>
        <p className="setting-hint" style={{ marginTop: 0, marginBottom: 12 }}>
          The difference between “saved” and “a message arrived” is every wrong password,
          blocked port and rejected sender there is. Send one before relying on alerts.
        </p>
        <div className="filter-row" style={{ marginBottom: 0 }}>
          <input
            type="email"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="you@yourdomain.com"
            style={{ minWidth: 260 }}
          />
          <button
            className="btn"
            onClick={sendTest}
            disabled={testing || !testTo.trim() || !data.configured}
            title={!data.configured ? 'Configure a host first' : undefined}
          >
            {testing ? 'Sending…' : 'Send test'}
          </button>
        </div>

        {test.at && (
          <div className={`test-result ${test.ok ? 'test-ok' : 'test-bad'}`}>
            {test.ok ? <IconCheck size={15} /> : <IconAlert size={15} />}
            <div>
              <b>{test.ok ? 'Delivered' : 'Failed'}</b> to {test.to} · {dateTime(test.at)}
              {/* The provider's own words. A generic "could not send" is what
                  turns a five-minute fix into a support ticket. */}
              {test.error && <div className="test-error">{test.error}</div>}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
