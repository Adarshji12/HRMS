/* HR Settings → Leave: the policy, and the leave types.
 *
 * Policy is the company-wide part: when the leave year starts, how much can carry forward and
 * whether leave can be encashed. The types themselves are the Leave Type Master. */

import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { canAdminister, useAuth } from '../../../lib/auth'
import { EmptyState, ErrorNote, Loading } from '../../../components/ui'
import { IconCalendar, IconReturn } from '../../../components/Icons'
import LeaveTypeMaster from '../../masters/LeaveTypeMaster'
import type { LeaveSettingsOut } from './MyLeave'

type Sub = 'policy' | 'types'

export default function LeavePolicyTab() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const sub: Sub = params.get('sub') === 'types' ? 'types' : 'policy'
  const go = (next: Sub) => {
    const keep: Record<string, string> = {}
    params.forEach((value, key) => { keep[key] = value })
    setParams({ ...keep, sub: next }, { replace: true })
  }
  const tabs: Array<{ key: Sub; label: string; icon: ReactNode }> = [
    { key: 'policy', label: 'Policy', icon: <IconReturn size={15} /> },
    { key: 'types', label: 'Leave Type', icon: <IconCalendar size={15} /> },
  ]

  if (!canAdminister(user)) {
    return <EmptyState title="Leave settings are for administrators" body="The leave year, quotas and who each type is offered to are set by an owner or administrator." />
  }

  return (
    <div className="hs-org">
      <nav className="hs-tabs hs-subtabs" role="tablist" aria-label="Leave settings">
        {tabs.map((t) => (
          <button key={t.key} role="tab" type="button" aria-selected={sub === t.key}
                  className={`hs-tab${sub === t.key ? ' is-on' : ''}`} onClick={() => go(t.key)}>
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>
      {sub === 'policy' ? <Policy /> : <LeaveTypeMaster />}
    </div>
  )
}

const YEARS: Array<{ month: number; label: string }> = [
  { month: 4, label: 'Financial year (Apr – Mar)' },
  { month: 1, label: 'Calendar year (Jan – Dec)' },
]
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function Policy() {
  const q = useQuery<LeaveSettingsOut>('leave-policy', () => api.get<LeaveSettingsOut>('/leave/settings'))
  const [draft, setDraft] = useState<{ month: string; carryMax: string; carry: boolean; encash: boolean; managerFirst: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  if (q.error) return <ErrorNote>{q.error}</ErrorNote>
  if (!q.data) return <Loading />

  const s = q.data
  const stored = {
    month: String(s.leave_year_start_month),
    carryMax: String((s.carry_forward_max_milli_days ?? 15000) / 1000),
    carry: s.carry_forward_enabled ?? true,
    encash: s.encash_enabled ?? false,
    managerFirst: s.manager_before_hr ?? true,
  }
  const form = draft ?? stored
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(stored)
  const set = (patch: Partial<typeof form>) => { setSaved(false); setDraft({ ...form, ...patch }) }
  const carryBad = form.carryMax.trim() === '' || !(Number(form.carryMax) >= 0 && Number(form.carryMax) <= 365)
  const known = YEARS.some((y) => String(y.month) === form.month)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await api.put('/leave/settings', {
        leave_year_start_month: Number(form.month),
        optional_holiday_quota: s.optional_holiday_quota,
        carry_forward_enabled: form.carry,
        carry_forward_max_milli_days: Math.round(Number(form.carryMax) * 1000),
        encash_enabled: form.encash,
        manager_before_hr: form.managerFirst,
      })
      setDraft(null)
      setSaved(true)
      q.reload()
    } catch (err) {
      setError((err as { message?: string }).message ?? 'Those settings could not be saved')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card hs-card">
      <header className="hs-card-head lp-head">
        <h2>Leave year and balances</h2>
        <span className="lp-note">Saved now, used by Leave</span>
      </header>
      <div className="hs-card-body">
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="lp-grid">
          <label className="hs-field">
            <span className="hs-label">Leave year</span>
            <select value={form.month} onChange={(e) => set({ month: e.target.value })}>
              {!known && <option value={form.month}>Year starting in {MONTHS[Number(form.month) - 1]}</option>}
              {YEARS.map((y) => <option key={y.month} value={y.month}>{y.label}</option>)}
            </select>
          </label>
          <label className="hs-field">
            <span className="hs-label">Maximum days carried forward</span>
            <input type="number" data-spin min={0} step="any" value={form.carryMax} disabled={!form.carry}
                   className={carryBad ? 'is-bad' : ''} onChange={(e) => set({ carryMax: e.target.value })} />
          </label>
        </div>
        <div className="lp-checks">
          <label className="crm-check"><input type="checkbox" checked={form.carry} onChange={(e) => set({ carry: e.target.checked })} /> Unused leave carries into the next year</label>
          <label className="crm-check"><input type="checkbox" checked={form.encash} onChange={(e) => set({ encash: e.target.checked })} /> Leave can be encashed</label>
          <label className="crm-check"><input type="checkbox" checked={form.managerFirst} onChange={(e) => set({ managerFirst: e.target.checked })} /> Reporting manager approves before HR</label>
        </div>
      </div>
      <div className="hs-actions">
        {saved && !dirty && <span className="hs-saved">Saved</span>}
        <button className="btn" disabled={!dirty || busy} onClick={() => { setDraft(null); setSaved(false) }}>Discard</button>
        <button className="btn btn-primary" disabled={!dirty || busy || carryBad} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </section>
  )
}
