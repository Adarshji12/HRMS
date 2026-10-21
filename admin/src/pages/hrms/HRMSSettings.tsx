/* HR Settings — every HRMS setting on one page, a tab per area.
 *
 * General is this page's own form (employee ID format, defaults and warning
 * windows, stored at /hr/settings). The other tabs are the settings screens
 * each module already has — Attendance, Leave, Approvals, Payroll, Expenses,
 * Notifications — mounted here so HR configures everything from one place.
 * The same screens stay reachable at their old /settings/* addresses.
 *
 * The tab is in the URL (?tab=leave) so a link can open the right one.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import '../../styles/hrsettings.css'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { canAdminister, useAuth } from '../../lib/auth'
import { ErrorNote, Loading } from '../../components/ui'
import { IconBell, IconCard, IconCheck, IconClock, IconGear, IconReturn, IconSheet } from '../../components/Icons'
import AttendanceSettings from './attendance/AttendanceSettings'
import LeaveSettings from './leave/LeaveSettings'
import WorkflowSetup from './workflow/WorkflowSetup'
import StatutorySettings from './payroll/StatutorySettings'
import ExpenseSettings from './expenses/ExpenseSettings'
import NotificationSettings from '../NotificationSettings'

export interface HrSettings {
  emp_code_prefix: string
  emp_code_separator: string
  emp_code_digits: number
  emp_code_next: number
  default_probation_months: number
  default_notice_days: number
  probation_warn_days: number
  document_warn_days: number
  next_code: string
}

type TabKey = 'general' | 'attendance' | 'leave' | 'approvals' | 'payroll' | 'expenses' | 'notifications'

const TABS: Array<{ key: TabKey; label: string; icon: ReactNode; admin: boolean }> = [
  { key: 'general', label: 'General', icon: <IconGear size={15} />, admin: false },
  { key: 'attendance', label: 'Attendance', icon: <IconClock size={15} />, admin: true },
  { key: 'leave', label: 'Leave', icon: <IconReturn size={15} />, admin: true },
  { key: 'approvals', label: 'Approvals', icon: <IconCheck size={15} />, admin: true },
  { key: 'payroll', label: 'Payroll', icon: <IconSheet size={15} />, admin: true },
  { key: 'expenses', label: 'Expenses', icon: <IconCard size={15} />, admin: true },
  { key: 'notifications', label: 'Notifications', icon: <IconBell size={15} />, admin: false },
]

export default function HRMSSettings() {
  const { user } = useAuth()
  const admin = canAdminister(user)
  const [params, setParams] = useSearchParams()
  const tabs = TABS.filter((t) => admin || !t.admin)
  const asked = params.get('tab') as TabKey | null
  const tab: TabKey = tabs.some((t) => t.key === asked) ? asked! : 'general'

  return (
    <div className="hs">
      <nav className="hs-tabs" role="tablist" aria-label="HR settings">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={tab === t.key}
            className={`hs-tab${tab === t.key ? ' is-on' : ''}`}
            onClick={() => setParams(t.key === 'general' ? {} : { tab: t.key }, { replace: true })}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>

      <div className="hs-panel" role="tabpanel">
        {tab === 'general' && <GeneralTab editable={admin} />}
        {tab === 'attendance' && <AttendanceSettings />}
        {tab === 'leave' && <LeaveSettings />}
        {tab === 'approvals' && <WorkflowSetup />}
        {tab === 'payroll' && <StatutorySettings />}
        {tab === 'expenses' && <ExpenseSettings />}
        {tab === 'notifications' && <NotificationSettings />}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- general --- */

function format(d: Pick<HrSettings, 'emp_code_prefix' | 'emp_code_separator' | 'emp_code_digits'>, n: number) {
  const digits = d.emp_code_digits > 0 ? String(n).padStart(d.emp_code_digits, '0') : String(n)
  const prefix = d.emp_code_prefix.trim().toUpperCase()
  return prefix ? `${prefix}${d.emp_code_separator}${digits}` : digits
}

function GeneralTab({ editable }: { editable: boolean }) {
  const q = useQuery<HrSettings>('hr-settings', () => api.get<HrSettings>('/hr/settings'))
  const [draft, setDraft] = useState<HrSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => { if (q.data) setDraft(q.data) }, [q.data])

  if (q.error) return <ErrorNote>{q.error}</ErrorNote>
  if (!draft) return <Loading />

  const dirty = JSON.stringify(draft) !== JSON.stringify(q.data)
  const set = <K extends keyof HrSettings>(k: K, v: HrSettings[K]) => {
    setDraft({ ...draft, [k]: v })
    setSaved(false)
  }
  const num = (k: keyof HrSettings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(k, (e.target.value === '' ? 0 : Math.max(0, Math.floor(Number(e.target.value)))) as never)

  /* The live preview follows the form, not the server, so the format can be
     tried before it is saved. The server skips codes already in use, so after
     saving the chip may move on by one or two — that is what it will issue. */
  const preview = dirty ? format(draft, draft.emp_code_next || 1) : draft.next_code

  async function save() {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      const { next_code: _ignored, ...body } = draft
      void _ignored
      const out = await api.put<HrSettings>('/hr/settings', body)
      setDraft(out)
      q.reload()
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the settings.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hs-general">
      {!editable && (
        <div className="hs-note">Only administrators can change these. You are seeing the current values.</div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}

      <section className="hs-card">
        <header className="hs-card-head">
          <h2>Employee ID format</h2>
          <p>How a new employee’s ID is built when nobody types one in.</p>
        </header>
        <div className="hs-card-body">
          <div className="hs-grid-4">
            <Field label="Prefix" hint="Blank for plain numbers">
              <input value={draft.emp_code_prefix} maxLength={12} placeholder="EMP" disabled={!editable}
                     onChange={(e) => set('emp_code_prefix', e.target.value.toUpperCase())} />
            </Field>
            <Field label="Separator" hint="Between prefix and number">
              <input value={draft.emp_code_separator} maxLength={3} placeholder="-" disabled={!editable}
                     onChange={(e) => set('emp_code_separator', e.target.value)} />
            </Field>
            <Field label="Digits" hint="0 turns padding off">
              <input type="number" min={0} max={10} value={draft.emp_code_digits} disabled={!editable}
                     onChange={num('emp_code_digits')} />
            </Field>
            <Field label="Next number" hint="Set it when migrating from another system">
              <input type="number" min={1} value={draft.emp_code_next} disabled={!editable}
                     onChange={num('emp_code_next')} />
            </Field>
          </div>
          <div className="hs-preview">
            The next employee will be <code className="hs-code">{preview}</code>
          </div>
          <p className="hs-foot-note">
            A code is minted once and never changes. Changing the format only affects employees added from now on.
          </p>
        </div>
      </section>

      <section className="hs-card">
        <header className="hs-card-head">
          <h2>Defaults and reminders</h2>
          <p>Pre-filled on the Add employee form, and the warning windows on the HR dashboard.</p>
        </header>
        <div className="hs-card-body">
          <div className="hs-grid-4">
            <Field label="Default probation (months)" hint="0 for no probation">
              <input type="number" min={0} max={36} value={draft.default_probation_months} disabled={!editable}
                     onChange={num('default_probation_months')} />
            </Field>
            <Field label="Default notice period (days)">
              <input type="number" min={0} max={365} value={draft.default_notice_days} disabled={!editable}
                     onChange={num('default_notice_days')} />
            </Field>
            <Field label="Warn before probation ends (days)">
              <input type="number" min={1} max={365} value={draft.probation_warn_days} disabled={!editable}
                     onChange={num('probation_warn_days')} />
            </Field>
            <Field label="Document expiry lookahead (days)">
              <input type="number" min={1} max={365} value={draft.document_warn_days} disabled={!editable}
                     onChange={num('document_warn_days')} />
            </Field>
          </div>
        </div>
      </section>

      {editable && (
        <div className="hs-actions">
          {saved && !dirty && <span className="hs-saved">Saved</span>}
          <button className="btn" disabled={!dirty || busy} onClick={() => { setDraft(q.data!); setSaved(false) }}>
            Discard
          </button>
          <button className="btn btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="hs-field">
      <span className="hs-label">{label}</span>
      {children}
      {hint && <span className="hs-hint">{hint}</span>}
    </label>
  )
}
