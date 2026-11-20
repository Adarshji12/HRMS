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
import { IconBell, IconBriefcase, IconBuilding, IconCheck, IconClock, IconGear, IconPin, IconReturn, IconSheet } from '../../components/Icons'
import DepartmentMaster from '../masters/DepartmentMaster'
import DesignationMaster from '../masters/DesignationMaster'
import BranchMaster from '../masters/BranchMaster'
import LocationMaster from '../masters/LocationMaster'
import AttendanceSettings from './attendance/AttendanceSettings'
import LeavePolicyTab from './leave/LeavePolicyTab'
import ApprovalRules from './workflow/ApprovalRules'
import PayrollTab from './payroll/PayrollTab'
import ExpenseSettings from './expenses/ExpenseSettings'
import NotificationsTab from './NotificationsTab'

export interface HrSettings {
  emp_code_prefix: string
  emp_code_separator: string
  emp_code_digits: number
  emp_code_next: number
  default_probation_months: number
  default_notice_days: number
  probation_warn_days: number
  document_warn_days: number
  birthday_lookahead_days: number
  next_code: string
}

type TabKey = 'general' | 'organisation' | 'attendance' | 'leave' | 'approvals' | 'payroll' | 'expenses' | 'notifications'

const TABS: Array<{ key: TabKey; label: string; icon: ReactNode; admin: boolean }> = [
  { key: 'general', label: 'General', icon: <IconGear size={15} />, admin: false },
  { key: 'organisation', label: 'Organisation', icon: <IconBuilding size={15} />, admin: true },
  { key: 'attendance', label: 'Attendance', icon: <IconClock size={15} />, admin: true },
  { key: 'leave', label: 'Leave', icon: <IconReturn size={15} />, admin: true },
  { key: 'approvals', label: 'Approvals', icon: <IconCheck size={15} />, admin: true },
  { key: 'payroll', label: 'Payroll', icon: <IconSheet size={15} />, admin: true },
//   { key: 'expenses', label: 'Expenses', icon: <IconCard size={15} />, admin: true },
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
        {tab === 'organisation' && <OrganisationTab />}
        {tab === 'attendance' && <AttendanceSettings embedded />}
        {tab === 'leave' && <LeavePolicyTab />}
        {tab === 'approvals' && <ApprovalRules />}
        {tab === 'payroll' && <PayrollTab />}
        {tab === 'expenses' && <ExpenseSettings />}
        {tab === 'notifications' && <NotificationsTab />}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------- organisation --- */

type OrgSub = 'department' | 'designation' | 'branch' | 'location'

/** The four organisation masters, listed here so the people who set HR up find them
 *  beside the rest of its settings. They are created and edited only in Master (each
 *  list has a Manage in Master button), and every picker elsewhere
 *  (Add employee, hierarchy, reports) offers what is listed. A location is the
 *  same record as Attendance → Locations, with a branch and an address added. */
function OrganisationTab() {
  const [params, setParams] = useSearchParams()
  const asked = params.get('sub')
  const sub: OrgSub = asked === 'designation' || asked === 'branch' || asked === 'location' ? asked : 'department'
  const go = (next: OrgSub) => setParams({ tab: 'organisation', sub: next }, { replace: true })
  const items: Array<{ key: OrgSub; label: string; icon: ReactNode }> = [
    { key: 'department', label: 'Department', icon: <IconBuilding size={15} /> },
    { key: 'designation', label: 'Designation', icon: <IconBriefcase size={15} /> },
    { key: 'branch', label: 'Branch', icon: <IconBuilding size={15} /> },
    { key: 'location', label: 'Location', icon: <IconPin size={15} /> },
  ]
  return (
    <div className="hs-org">
      <nav className="hs-tabs hs-subtabs" role="tablist" aria-label="Organisation">
        {items.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={sub === t.key}
            className={`hs-tab${sub === t.key ? ' is-on' : ''}`}
            onClick={() => go(t.key)}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>
      {sub === 'department' ? <DepartmentMaster readOnly /> : sub === 'designation' ? <DesignationMaster readOnly /> : sub === 'branch' ? <BranchMaster readOnly /> : <LocationMaster readOnly />}
    </div>
  )
}

/* ------------------------------------------------------------- general --- */

function format(d: Pick<HrSettings, 'emp_code_prefix' | 'emp_code_separator' | 'emp_code_digits'>, n: number) {
  const digits = d.emp_code_digits > 0 ? String(n).padStart(d.emp_code_digits, '0') : String(n)
  const prefix = d.emp_code_prefix.trim().toUpperCase()
  return prefix ? `${prefix}${d.emp_code_separator}${digits}` : digits
}

/** Every time zone the browser knows, with the office's own always present. */
function zoneList(current: string): string[] {
  const known = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  return known.includes(current) ? known : [current, ...known]
}

/** The date, as yyyy-mm-dd, in a given zone right now. */
function dateIn(zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date())
  } catch {
    return '—'
  }
}

function GeneralTab({ editable }: { editable: boolean }) {
  const { organization } = useAuth()
  const stored = organization?.timezone ?? 'UTC'
  const [zone, setZone] = useState(stored)
  const q = useQuery<HrSettings>('hr-settings', () => api.get<HrSettings>('/hr/settings'))
  const [draft, setDraft] = useState<HrSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => { if (q.data) setDraft(q.data) }, [q.data])

  if (q.error) return <ErrorNote>{q.error}</ErrorNote>
  if (!draft) return <Loading />

  const zoneChanged = zone !== stored
  const dirty = JSON.stringify(draft) !== JSON.stringify(q.data) || zoneChanged
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
      if (zoneChanged) {
        await api.put('/org/company', { timezone: zone })
        // The workspace's zone is part of the signed-in session's tenant info, so reload to
        // let every screen that tells the date read the new one.
        window.location.reload()
        return
      }
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
            <Field label="Separator">
              <input value={draft.emp_code_separator} maxLength={3} placeholder="-" disabled={!editable}
                     onChange={(e) => set('emp_code_separator', e.target.value)} />
            </Field>
            <Field label="Digits" hint="0 turns padding off">
              <input placeholder="4" type="number" min={0} max={10} value={draft.emp_code_digits} disabled={!editable}
                     onChange={num('emp_code_digits')} />
            </Field>
            <Field label="Next number" hint="Set it when migrating">
              <input placeholder="101" type="number" min={1} value={draft.emp_code_next} disabled={!editable}
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
        </header>
        <div className="hs-card-body">
          <div className="hs-grid-3">
            <Field label="Default probation (months)">
              <input placeholder="6" type="number" min={0} max={36} value={draft.default_probation_months} disabled={!editable}
                     onChange={num('default_probation_months')} />
            </Field>
            <Field label="Warn before probation ends (days)" hint="0 = never">
              <input placeholder="30" type="number" min={0} max={365} value={draft.probation_warn_days} disabled={!editable}
                     onChange={num('probation_warn_days')} />
            </Field>
            <Field label="Birthday lookahead (days)">
              <input placeholder="30" type="number" min={0} max={365} value={draft.birthday_lookahead_days} disabled={!editable}
                     onChange={num('birthday_lookahead_days')} />
            </Field>
          </div>
        </div>
      </section>

      <section className="hs-card">
        <header className="hs-card-head">
          <h2>Time zone</h2>
        </header>
        <div className="hs-card-body">
          <div className="hs-zone">
            <label className="hs-field">
              <span className="hs-label">The office clock</span>
              <select value={zone} disabled={!editable} onChange={(e) => { setZone(e.target.value); setSaved(false) }}>
                {zoneList(stored).map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </label>
            <div className="hs-preview hs-zone-now">
              It is <code className="hs-code">{dateIn(zone)}</code> there now.
            </div>
          </div>
          <p className="hs-foot-note">
            Attendance uses this to decide whether a working day has finished — which is what turns an unmarked day
            into an absence. Getting it wrong leaves the register a day out of step with the office.
          </p>
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
