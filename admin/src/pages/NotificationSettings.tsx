import { useEffect, useState } from 'react'
import '../styles/org.css'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { useAuth } from '../lib/auth'
import { dateTime } from '../lib/format'
import { Empty, ErrorNote, Loading } from '../components/ui'
import { IconAlert } from '../components/Icons'

/**
 * What this system may send you, decided by you.
 *
 * Self-service on purpose. There is no administrator route to change someone
 * else's preferences: being able to silence a colleague's "a device was
 * enrolled against your account" would defeat the reason that alert exists.
 */

interface Preference {
  kind: string
  label: string
  description: string
  audience: 'employee' | 'manager' | 'admin'
  optional: boolean
  enabled: boolean
}

interface Payload {
  email_configured: boolean
  preferences: Preference[]
}

interface HistoryItem {
  kind: string
  label: string
  subject: string
  status: string
  sent_at: string
}

const AUDIENCE_LABEL: Record<Preference['audience'], string> = {
  employee: 'About my own work',
  manager: 'About people I manage',
  admin: 'About this workspace',
}

const STATUS_LABEL: Record<string, string> = {
  sent: 'Delivered',
  logged: 'Not sent — no mail server configured',
  failed: 'Failed',
  pending: 'Pending',
}

export default function NotificationSettings() {
  const { user } = useAuth()
  const { data, error, loading, reload } = useQuery<Payload>('notif-prefs', () =>
    api.get<Payload>('/notifications/preferences'),
  )
  const history = useQuery<{ items: HistoryItem[] }>('notif-history', () =>
    api.get<{ items: HistoryItem[] }>('/notifications/history'),
  )

  const [draft, setDraft] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (data) setDraft(Object.fromEntries(data.preferences.map((p) => [p.kind, p.enabled])))
  }, [data])

  if (error) return <ErrorNote>{error}</ErrorNote>
  if (loading || !data) return <Loading />

  const dirty = data.preferences.some((p) => p.optional && draft[p.kind] !== p.enabled)

  async function save() {
    if (!data) return
    setSaving(true)
    setSaveError(null)
    try {
      await api.put('/notifications/preferences', {
        preferences: data.preferences
          .filter((p) => p.optional)
          .map((p) => ({ kind: p.kind, email_enabled: draft[p.kind] ?? p.enabled })),
      })
      setSaved(true)
      reload()
      window.setTimeout(() => setSaved(false), 2500)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const groups: Array<Preference['audience']> = ['employee', 'manager', 'admin']

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Notifications</h1>
          <p className="page-sub">
            Email sent to {user?.email}. These are your own settings — nobody else can
            change what you receive.
          </p>
        </div>
        <div className="head-actions">
          {saved && <span className="card-note">Saved</span>}
          <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>

      {saveError && <ErrorNote>{saveError}</ErrorNote>}

      {/* The admin needs to know delivery is off before anyone relies on it. It
          is a WARNING in the server log too, but nobody reads a log to find out
          why they never got an email. */}
      {!data.email_configured && (
        <div className="notice" style={{ marginBottom: 16 }}>
          <IconAlert size={15} />{' '}
          <b>No mail server is configured.</b> These settings are saved, but nothing is
          delivered yet — messages are written to the server log instead. Set{' '}
          <code>SMTP_HOST</code> on the server to switch delivery on.
        </div>
      )}

      {groups.map((audience) => {
        const items = data.preferences.filter((p) => p.audience === audience)
        if (items.length === 0) return null
        return (
          <section className="card" style={{ marginBottom: 14 }} key={audience}>
            <div className="card-head">
              <h2 className="card-title">{AUDIENCE_LABEL[audience]}</h2>
            </div>
            {items.map((p) => (
              <label className="notif-row" key={p.kind}>
                <input
                  type="checkbox"
                  checked={p.optional ? (draft[p.kind] ?? p.enabled) : true}
                  disabled={!p.optional}
                  onChange={(e) => setDraft({ ...draft, [p.kind]: e.target.checked })}
                />
                <span className="notif-body">
                  <span className="notif-label">
                    {p.label}
                    {!p.optional && <span className="notif-required">Always on</span>}
                  </span>
                  <span className="notif-desc">{p.description}</span>
                </span>
              </label>
            ))}
          </section>
        )
      })}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Recently sent to you</h2>
          <span className="card-note">last 30 days</span>
        </div>
        {history.data && history.data.items.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>When</th><th>Notification</th><th>Subject</th><th>Status</th></tr>
              </thead>
              <tbody>
                {history.data.items.map((item, i) => (
                  <tr key={`${item.kind}-${item.sent_at}-${i}`}>
                    <td>{dateTime(item.sent_at)}</td>
                    <td>{item.label}</td>
                    <td className="muted-sm">{item.subject}</td>
                    <td>{STATUS_LABEL[item.status] ?? item.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Nothing has been sent to you yet.</Empty>
        )}
      </section>
    </div>
  )
}
