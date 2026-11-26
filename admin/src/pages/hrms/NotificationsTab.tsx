/* Settings → Notifications: the company's email events.
 *
 * Email only. Each event can be switched on or off, and its subject and body reworded with
 * placeholders.
 */

import { useState } from 'react'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { canAdminister, useAuth } from '../../lib/auth'
import { ErrorNote, Loading } from '../../components/ui'
import { IconMail } from '../../components/Icons'
import NotificationSettings from '../NotificationSettings'
import '../../styles/hrsettings.css'

interface EventRow {
  key: string; label: string; description: string; audience: 'employee' | 'manager'; schedule: string | null
  is_enabled: boolean; subject: string; body: string; default_subject: string; default_body: string
}
interface Payload {
  email_configured: boolean
  placeholders: string[]
  events: EventRow[]
  alerts: { probation_alert: boolean; document_alert: boolean }
}

const WHO = { employee: 'The employee', manager: 'Their reporting manager' } as const

export default function NotificationsTab() {
  const { user } = useAuth()
  if (!canAdminister(user)) return <NotificationSettings />
  return <div className="page"><Events /></div>
}

function Events() {
  const q = useQuery<Payload>('notif-rules', () => api.get<Payload>('/notifications/rules'))
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (q.error) return <ErrorNote>{q.error}</ErrorNote>
  if (!q.data) return <Loading />
  const data = q.data

  async function put(path: string, body: unknown) {
    setError(null)
    try {
      await api.put(path, body)
      q.reload()
    } catch (err) {
      setError((err as { message?: string }).message ?? 'That could not be saved')
    }
  }

  return (
    <div className="hs-org">
      {error && <ErrorNote>{error}</ErrorNote>}

      <section className="card hs-card">
        <header className="hs-card-head lp-head nt-head">
          <h2><IconMail size={15} /> Email Notifications</h2>
        </header>
        <div className="hs-card-body">
          <p className="nt-intro">
            Sends from the account’s configured mail settings. Subject and body are yours to write.
            {!data.email_configured && <> <b>No mail server is configured yet</b>, so messages are not delivered yet.</>}
          </p>
          {data.events.map((ev) => (
            <EventCard key={ev.key} ev={ev} placeholders={data.placeholders} open={open === ev.key}
                       onOpen={() => setOpen(open === ev.key ? null : ev.key)}
                       onToggle={(on) => void put(`/notifications/rules/${ev.key}`, { is_enabled: on })}
                       onSave={async (subject, body) => { await put(`/notifications/rules/${ev.key}`, { subject, body }) }} />
          ))}
        </div>
      </section>
    </div>
  )
}

function EventCard({ ev, placeholders, open, onOpen, onToggle, onSave }: {
  ev: EventRow; placeholders: string[]; open: boolean
  onOpen: () => void; onToggle: (on: boolean) => void; onSave: (subject: string, body: string) => Promise<void>
}) {
  const [subject, setSubject] = useState<string | null>(null)
  const [body, setBody] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const s = subject ?? ev.subject
  const b = body ?? ev.body
  const dirty = s !== ev.subject || b !== ev.body

  return (
    <div className="nt-event">
      <div className="nt-row">
        <div className="nt-main">
          <div className="nt-title">
            <b>{ev.label}</b>
            <span className="nt-chip">{WHO[ev.audience]}</span>
            {ev.schedule && <span className="nt-chip">{ev.schedule}</span>}
          </div>
          <p className="muted-sm">{ev.description}</p>
        </div>
        <button type="button" className="btn btn-sm nt-manage" onClick={onOpen} aria-expanded={open}>{open ? 'Hide' : 'Manage'} {open ? '▴' : '▾'}</button>
        <button type="button" role="switch" aria-checked={ev.is_enabled} aria-label={`${ev.label} on or off`}
                className={`hs-switch${ev.is_enabled ? ' is-on' : ''}`} onClick={() => onToggle(!ev.is_enabled)}><span /></button>
      </div>
      {open && (
        <div className="nt-edit">
          <label className="hs-field"><span className="hs-label">Subject</span>
            <input value={s} maxLength={300} onChange={(e) => setSubject(e.target.value)} /></label>
          <label className="hs-field"><span className="hs-label">Body</span>
            <textarea rows={6} value={b} onChange={(e) => setBody(e.target.value)} /></label>
          <p className="muted-sm">Placeholders: {placeholders.map((p) => `{${p}}`).join(' ')}</p>
          <div className="hs-actions">
            <button className="btn" disabled={busy} onClick={() => { setSubject(ev.default_subject); setBody(ev.default_body) }}>Use the default wording</button>
            <button className="btn btn-primary" disabled={busy || !dirty} onClick={async () => {
              setBusy(true)
              await onSave(s, b)
              setSubject(null); setBody(null); setBusy(false)
            }}>{busy ? 'Saving…' : 'Save wording'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
