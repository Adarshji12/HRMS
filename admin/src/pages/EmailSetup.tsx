import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import '../styles/org.css'
import '../styles/emailSetup.css'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { useAuth } from '../lib/auth'
import { dateTime } from '../lib/format'
import { ErrorNote, Loading } from '../components/ui'
import { IconAlert, IconBuilding, IconCheck, IconMail, IconUsers } from '../components/Icons'

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

/** Where the common providers' SMTP lives; picking one fills the host, port and encryption. */
const PRESETS: Array<{ name: string; host: string; port: number; tls: boolean; user?: string; note: string }> = [
  { name: 'Microsoft 365', host: 'smtp.office365.com', port: 587, tls: true, note: 'SMTP AUTH must be enabled for the mailbox.' },
  { name: 'Google Workspace', host: 'smtp.gmail.com', port: 587, tls: true, note: 'Use an app password, not the account password.' },
  { name: 'Amazon SES', host: 'email-smtp.us-east-1.amazonaws.com', port: 587, tls: true, note: 'Change the region in the host if yours differs; use the SMTP credentials, not your IAM login.' },
  { name: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, tls: true, user: 'apikey', note: 'The username is the word apikey; the password is your API key.' },
]

const parseFrom = (value: string) => {
  const m = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  return m ? { name: m[1].trim(), address: m[2].trim() } : { name: '', address: value.trim() }
}

function Section({ n, title }: { n: number; title: string }) {
  return <div className="es-sec"><span>{n}. {title}</span></div>
}

function Adorn({ icon, children, mono }: { icon: ReactNode; children: ReactNode; mono?: boolean }) {
  return <span className={`es-in${mono ? ' is-mono' : ''}`}><i aria-hidden>{icon}</i>{children}</span>
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
  const [showPw, setShowPw] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [presetNote, setPresetNote] = useState<string | null>(null)
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

  async function put(body: Record<string, unknown>, done?: string) {
    setSaving(true); setFormError(null)
    try {
      await api.put('/admin/mail', body)
      setSaved(true); reload()
      window.setTimeout(() => setSaved(false), 2500)
      if (done) setPresetNote(done)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save')
    } finally { setSaving(false) }
  }

  function save(event: FormEvent) {
    event.preventDefault()
    void put({ ...form, ...(password === undefined ? {} : { smtp_password: password }) })
  }

  function resetToShared() {
    if (!window.confirm('Go back to the platform’s shared mail server? Your own server details and password will be cleared.')) return
    setPassword(undefined)
    void put({ smtp_host: '', smtp_port: 587, smtp_user: '', smtp_use_tls: true, email_from: '', smtp_password: '' })
  }

  function applyPreset(p: (typeof PRESETS)[number]) {
    setForm((f) => ({ ...f, smtp_host: p.host, smtp_port: p.port, smtp_use_tls: p.tls, smtp_user: p.user ?? f.smtp_user }))
    setPresetNote(`${p.name}: ${p.note}`)
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
  const from = parseFrom(form.email_from || '')
  const previewName = from.name || organization?.name || 'Your company'
  const previewAddr = from.address || (form.smtp_user.includes('@') ? form.smtp_user : 'alerts@yourcompany.com')
  const initials = previewName.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()

  return (
    <div className="es">
      <div className="page-head">
        <div>
          <h1 className="page-title">Email setup</h1>
          <p className="page-sub">
            The address company mail is sent from. Only the owner can change it.
          </p>
        </div>
      </div>

      <div className={`notice${data.configured ? '' : ' notice-warn'}`} style={{ marginBottom: 16 }}>
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

      <div className="es-grid">
        <form className="es-card" onSubmit={save}>
          <header className="es-head">
            <i className="es-ic" aria-hidden><IconMail size={18} /></i>
            <div>
              <h2>Your SMTP server</h2>
              <p>Custom relay credentials for your organisation’s own emails</p>
            </div>
            <div className="es-presets">
              <span>Presets:</span>
              {PRESETS.map((p) => <button key={p.name} type="button" onClick={() => applyPreset(p)}>{p.name}</button>)}
            </div>
          </header>
          {presetNote && <div className="es-presetnote">{presetNote}</div>}

          <div className="es-body">
            <Section n={1} title="Server & encryption" />
            <div className="es-two es-hostport">
              <label className="es-f"><span className="es-fl">Host</span>
                <Adorn icon={<IconBuilding size={15} />} mono>
                  <input value={form.smtp_host} placeholder="smtp.office365.com" autoComplete="off"
                         onChange={(e) => setForm({ ...form, smtp_host: e.target.value })} />
                </Adorn>
                <span className="es-hint">Leave blank to keep using the platform’s shared server.</span>
              </label>
              <label className="es-f"><span className="es-fl es-fl-row">Port
                <span className="es-quick">
                  <button type="button" className={form.smtp_port === 587 ? 'is-on' : ''} onClick={() => setForm({ ...form, smtp_port: 587 })}>587 STARTTLS</button>
                  <button type="button" className={form.smtp_port === 465 ? 'is-on' : ''} onClick={() => setForm({ ...form, smtp_port: 465 })}>465 SSL/TLS</button>
                </span></span>
                <input className="es-plain is-mono" placeholder="587" type="number" min={1} max={65535} value={form.smtp_port}
                       onChange={(e) => setForm({ ...form, smtp_port: Number(e.target.value) })} />
                <span className="es-hint">587 for STARTTLS, 465 for implicit TLS.</span>
              </label>
            </div>
            <div className="es-row">
              <i aria-hidden><IconCheck size={15} /></i>
              <div>
                <b>Use STARTTLS</b>
                <span>{form.smtp_port === 465
                  ? 'Ignored on port 465, which is encrypted from the start.'
                  : `Upgrades a plain connection to encrypted TLS on port ${form.smtp_port}`}</span>
              </div>
              <button type="button" role="switch" aria-checked={form.smtp_use_tls && form.smtp_port !== 465} aria-label="Use STARTTLS"
                      disabled={form.smtp_port === 465}
                      className={`hs-switch${form.smtp_use_tls && form.smtp_port !== 465 ? ' is-on' : ''}`}
                      onClick={() => setForm({ ...form, smtp_use_tls: !form.smtp_use_tls })}><span /></button>
            </div>

            <Section n={2} title="Authentication credentials" />
            <div className="es-two">
              <label className="es-f"><span className="es-fl">Username</span>
                <Adorn icon={<IconUsers size={15} />} mono>
                  <input value={form.smtp_user} placeholder="alerts@yourcompany.com" autoComplete="off"
                         onChange={(e) => setForm({ ...form, smtp_user: e.target.value })} />
                </Adorn>
                <span className="es-hint">Usually your full email address or SMTP key ID.</span>
              </label>
              <label className="es-f"><span className="es-fl es-fl-row">Password <em className="es-aes">AES-256 encrypted</em></span>
                <span className="es-in is-mono">
                  <i aria-hidden>🔑</i>
                  <input type={showPw ? 'text' : 'password'} value={password ?? ''} autoComplete="new-password"
                         placeholder={data.has_password ? '•••••••• (unchanged)' : 'not set'}
                         onChange={(e) => setPassword(e.target.value)} />
                  <button type="button" className="es-eye" aria-label={showPw ? 'Hide password' : 'Show password'} onClick={() => setShowPw((v) => !v)}>{showPw ? 'Hide' : 'Show'}</button>
                </span>
                <span className="es-hint">Stored encrypted and never shown again. Leave untouched to keep it.</span>
              </label>
            </div>

            <Section n={3} title="Sender identity" />
            <div className="es-two">
              <label className="es-f"><span className="es-fl">From address</span>
                <Adorn icon={<span>@</span>}>
                  <input value={form.email_from} placeholder={`${organization?.name ?? 'Your company'} <alerts@yourcompany.com>`}
                         onChange={(e) => setForm({ ...form, email_from: e.target.value })} />
                </Adorn>
                <span className="es-hint">Must be an address your provider lets you send from, or messages bounce. Left blank, the username is used.</span>
              </label>
              <div className="es-preview">
                <small>Inbox preview</small>
                <div><i>{initials || 'AD'}</i><div><b>{previewName}</b><span>&lt;{previewAddr}&gt;</span></div></div>
              </div>
            </div>
          </div>

          <footer className="es-foot">
            <button type="button" className="es-reset" onClick={resetToShared} disabled={saving}>↺ Reset to shared server</button>
            {saved && <span className="es-saved">Saved</span>}
            <button className="btn btn-primary es-save" type="submit" disabled={saving}>{saving ? 'Saving…' : '✓ Save configuration'}</button>
          </footer>
        </form>

        <aside className="es-side">
          <section className="es-card">
            <header className="es-head">
              <i className="es-ic is-blue" aria-hidden><IconMail size={18} /></i>
              <div><h2>Send a test message</h2></div>
              <span className="es-live">Live verification</span>
            </header>
            <div className="es-body">
              <div className="es-warn">
                <IconAlert size={15} />
                <p><b>Saving only proves the form is valid</b> — send a real test email to verify credentials, the TLS handshake and inbox delivery.</p>
              </div>
              <label className="es-f"><span className="es-fl">Recipient email</span>
                <input className="es-plain is-mono" type="email" value={testTo} placeholder="admin@yourcompany.com"
                       onChange={(e) => setTestTo(e.target.value)} />
              </label>
              <label className="es-f"><span className="es-fl">Message template</span>
                <select className="es-plain" value="test" onChange={() => undefined}>
                  <option value="test">SMTP connection test</option>
                </select>
              </label>
              <button type="button" className="es-send" onClick={() => void sendTest()}
                      disabled={testing || !testTo.trim() || !data.configured}>
                {testing ? 'Sending…' : '➤ Send test email'}
              </button>
              {!data.configured && <span className="es-hint">Save a host first, then the test can run.</span>}
              {test.at && (
                <div className={`test-result ${test.ok ? 'test-ok' : 'test-bad'}`}>
                  {test.ok ? <IconCheck size={15} /> : <IconAlert size={15} />}
                  <div>
                    <b>{test.ok ? 'Delivered' : 'Failed'}</b> to {test.to} · {dateTime(test.at)}
                    {test.error && <div className="test-error">{test.error}</div>}
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="es-card">
            <header className="es-head">
              <i className="es-ic is-green" aria-hidden><IconCheck size={18} /></i>
              <div><h2>Deliverability checklist</h2></div>
              <span className="es-dns">DNS best practices</span>
            </header>
            <ul className="es-list">
              <li><b>SPF record</b><span>Authorise your mail server’s IP in the domain’s TXT records.</span></li>
              <li><b>DKIM signing</b><span>Cryptographically sign payslip and HR letter headers.</span></li>
              <li><b>From-domain match</b><span>Make sure the From domain matches the authenticated SMTP user.</span></li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  )
}
