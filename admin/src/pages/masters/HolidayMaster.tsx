/* Holiday Master — the company's holiday calendar, kept with the other masters.
 *
 * The same holidays as Leave Settings → Holiday calendar, listed here with their
 * type and the branch they apply to. A restricted (optional) holiday is only a day
 * off for the employees who chose it; everyone else is expected at work.
 * A holiday with no branch is observed by every branch.
 */

import { useMemo, useState, type ReactNode } from 'react'
import '../../styles/crm.css'
import '../../styles/org.css'
import { api } from '../../lib/api'
import { shortDate } from '../../lib/format'
import { useQuery } from '../../lib/useQuery'
import { canAdminister, useAuth } from '../../lib/auth'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconCopy, IconEdit, IconPlus, IconSearch, IconSheet, IconTrash } from '../../components/Icons'
import { Dialog, Field } from '../crm/parts'
import { ColumnSettings, useColumns, type ColumnDef } from '../../components/ViewSettings'
import type { Holiday } from '../hrms/leave/MyLeave'
import type { Branch } from './BranchMaster'

export const HOLIDAY_TYPES: Array<{ value: string; label: string }> = [
  { value: 'public', label: 'Public Holiday' },
  { value: 'national', label: 'National Holiday' },
  { value: 'festival', label: 'Festival' },
  { value: 'optional', label: 'Optional / Restricted' },
  { value: 'company', label: 'Company Holiday' },
]
const typeLabel = (value: string) => HOLIDAY_TYPES.find((t) => t.value === value)?.label ?? value

type HolidayColumn = ColumnDef & { td: (row: Holiday) => ReactNode; className?: string; thClass?: string }
const dash = <span className="crm-muted">—</span>
const HOLIDAY_COLUMNS: HolidayColumn[] = [
  { key: 'date', label: 'Date', locked: true, className: 'crm-nowrap', td: (h) => (
    <>
      <span className="crm-strong">{shortDate(h.holiday_date)}</span>
      <div className="crm-sub">{new Date(`${h.holiday_date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' })}</div>
    </>
  ) },
  { key: 'name', label: 'Holiday', td: (h) => (
    <>
      <span className="crm-strong">{h.name}</span>
      {h.description && <div className="crm-sub">{h.description}</div>}
    </>
  ) },
  { key: 'type', label: 'Type', td: (h) => typeLabel(h.holiday_type ?? 'public') },
  { key: 'branch', label: 'Branch', className: 'crm-muted', td: (h) => h.branch_name ?? 'All branches' },
  { key: 'opted', label: 'Opted in', className: 'crm-num', thClass: 'crm-num', td: (h) => (h.is_optional ? (h.opt_in_count ?? 0) : dash) },
  { key: 'status', label: 'Status', td: (h) => (
    <span className={`crm-state ${h.is_active ? 'crm-state-good' : 'crm-state-idle'}`}>{h.is_active ? 'Active' : 'Inactive'}</span>
  ) },
]

export default function HolidayMaster({ readOnly = false }: { readOnly?: boolean }) {
  const columns = useColumns('holidays', HOLIDAY_COLUMNS)
  const { user } = useAuth()
  const isAdmin = canAdminister(user) && !readOnly
  const holidays = useQuery<Holiday[]>('holiday-master', () => api.get<Holiday[]>('/leave/holidays?include_inactive=true'))
  const branches = useQuery<Branch[]>('branches', () => api.get<Branch[]>('/org/branches'))
  const thisYear = String(new Date().getFullYear())
  const [year, setYear] = useState(thisYear)
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Holiday | 'new' | null>(null)
  const [copying, setCopying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const years = useMemo(() => {
    const found = new Set((holidays.data ?? []).map((h) => h.holiday_date.slice(0, 4)))
    found.add(thisYear)
    return [...found].sort()
  }, [holidays.data, thisYear])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (holidays.data ?? []).filter((h) =>
      (year === '' || h.holiday_date.startsWith(year)) &&
      (!needle || [h.name, h.branch_name, typeLabel(h.holiday_type ?? 'public')].some((v) => (v ?? '').toLowerCase().includes(needle))))
  }, [holidays.data, q, year])

  async function remove(holiday: Holiday) {
    if (!window.confirm(`Remove “${holiday.name}” from the calendar?`)) return
    setError(null)
    try {
      await api.del(`/leave/holidays/${holiday.id}`)
      holidays.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That holiday could not be removed')
    }
  }

  return (
    <div className="crm">
      <section className="card dm-card">
        <div className="dm-head">
          <span className="dm-tile dm-tile-violet"><IconSheet size={18} /></span>
          <div className="dm-heading">
            <h1 className="dm-title">Holiday Master</h1>
            <p className="crm-sub">The days the company is closed, by type and by branch.</p>
          </div>
          <div className="dm-tools">
            <div className="crm-search dm-search">
              <IconSearch size={15} />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
                     placeholder="Search holidays…" aria-label="Search holidays" />
            </div>
            <select value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year">
              <option value="">All years</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <span className="crm-sub crm-nowrap">{rows.length} holiday{rows.length === 1 ? '' : 's'}</span>
            <ColumnSettings defs={HOLIDAY_COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden}
                            onSave={columns.save} onReset={columns.reset} />
            {isAdmin && (
              <button className="btn" onClick={() => setCopying(true)}>
                <IconCopy size={15} /> Copy year
              </button>
            )}
            {isAdmin && (
              <button className="btn btn-primary" onClick={() => setEditing('new')}>
                <IconPlus size={15} /> Add Holiday
              </button>
            )}
          </div>
        </div>

        {(error || holidays.error) && <div className="dm-error"><ErrorNote>{error ?? holidays.error}</ErrorNote></div>}

        {holidays.loading && !holidays.data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState
            title={q || year ? 'No holiday matches' : 'No holidays yet'}
            body={q || year ? 'Try another year or search.' : 'Add the days the company is closed.'}
            action={isAdmin && !q ? <button className="btn btn-primary" onClick={() => setEditing('new')}>Add a holiday</button> : undefined}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {(columns.visible as HolidayColumn[]).map((col) => <th key={col.key} className={col.thClass}>{col.label}</th>)}
                  {isAdmin && <th style={{ textAlign: 'right' }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((h) => (
                  <tr key={h.id}>
                    {(columns.visible as HolidayColumn[]).map((col) => <td key={col.key} className={col.className}>{col.td(h)}</td>)}
                    {isAdmin && (
                      <td>
                        <div className="crm-row-actions">
                          <button className="crm-icon-btn" onClick={() => setEditing(h)} aria-label={`Edit ${h.name}`} title="Edit">
                            <IconEdit size={16} />
                          </button>
                          <button className="crm-icon-btn dm-delete" onClick={() => remove(h)} aria-label={`Delete ${h.name}`} title="Delete">
                            <IconTrash size={16} />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {copying && (
        <CopyYearDialog
          holidays={holidays.data ?? []}
          years={years}
          onClose={() => setCopying(false)}
          onDone={(target) => { setCopying(false); setYear(target); holidays.reload() }}
        />
      )}

      {editing && (
        <HolidayDialog
          holiday={editing === 'new' ? null : editing}
          branches={branches.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); holidays.reload() }}
        />
      )}
    </div>
  )
}

function HolidayDialog({
  holiday, branches, onClose, onSaved,
}: {
  holiday: Holiday | null
  branches: Branch[]
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    name: holiday?.name ?? '',
    holiday_date: holiday?.holiday_date ?? new Date().toLocaleDateString('en-CA'),
    holiday_type: holiday?.holiday_type ?? 'public',
    branch_id: holiday?.branch_id ?? '',
    is_optional: holiday?.is_optional ?? false,
    is_active: holiday?.is_active ?? true,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  async function save() {
    if (!form.name.trim()) return setError('Give the holiday a name.')
    if (!form.holiday_date) return setError('Pick the date.')
    setBusy(true)
    setError(null)
    const body = {
      name: form.name.trim(),
      holiday_date: form.holiday_date,
      holiday_type: form.holiday_type,
      branch_id: form.branch_id || null,
      is_optional: form.is_optional,
      is_active: form.is_active,
      // The older calendar form's description is kept as it was.
      description: holiday?.description ?? null,
    }
    try {
      if (holiday) await api.put(`/leave/holidays/${holiday.id}`, body)
      else await api.post('/leave/holidays', body)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That holiday could not be saved')
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={holiday ? `Edit ${holiday.name}` : 'Add Holiday'}
      narrow
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.name.trim()}>
            {busy ? 'Saving…' : holiday ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      <div className="crm-form">
        {error && <div className="crm-form-wide"><ErrorNote>{error}</ErrorNote></div>}
        <Field label="Holiday name" wide required>
          <input value={form.name} placeholder="Independence Day" autoFocus onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Date" required>
          <input type="date" value={form.holiday_date} onChange={(e) => set({ holiday_date: e.target.value })} />
        </Field>
        <Field label="Type">
          <select
            value={form.holiday_type}
            onChange={(e) => set({ holiday_type: e.target.value, is_optional: e.target.value === 'optional' ? true : form.is_optional })}
          >
            {HOLIDAY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Field>
        <Field label="Branch" wide hint="Leave blank when every branch observes it">
          <select value={form.branch_id} onChange={(e) => set({ branch_id: e.target.value })}>
            <option value="">— All branches —</option>
            {branches.filter((b) => b.is_active || b.id === form.branch_id).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        <div className="crm-field crm-form-wide om-checks">
          <label className="crm-check">
            <input
              type="checkbox"
              checked={form.is_optional}
              onChange={(e) => set({
                is_optional: e.target.checked,
                // Unticking restricted takes it off the Optional / Restricted type.
                holiday_type: !e.target.checked && form.holiday_type === 'optional' ? 'public' : form.holiday_type,
              })}
            />
            Restricted — employees choose whether to take it
          </label>
          {holiday && (
            <label className="crm-check">
              <input type="checkbox" checked={form.is_active} onChange={(e) => set({ is_active: e.target.checked })} />
              Active
            </label>
          )}
        </div>
      </div>
    </Dialog>
  )
}

/** Copies one year's calendar into another, the same dates a year on. Holidays that
 *  already exist on the target date with the same name are skipped, so running it twice
 *  does not double the calendar. 29 February lands on 28 February in a common year. */
function CopyYearDialog({
  holidays, years, onClose, onDone,
}: {
  holidays: Holiday[]
  years: string[]
  onClose: () => void
  onDone: (target: string) => void
}) {
  const thisYear = new Date().getFullYear()
  const [from, setFrom] = useState(String(thisYear - 1))
  const [to, setTo] = useState(String(thisYear))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const choices = [...new Set([...years, String(thisYear - 1), String(thisYear), String(thisYear + 1)])].sort()
  const source = holidays.filter((h) => h.holiday_date.startsWith(from))

  const moved = (iso: string) => {
    const [, month, day] = iso.split('-')
    const target = `${to}-${month}-${day}`
    return Number.isNaN(Date.parse(target)) ? `${to}-02-28` : target
  }

  async function copy() {
    if (from === to) return setError('Pick two different years.')
    setBusy(true)
    setError(null)
    const have = new Set(holidays.filter((h) => h.holiday_date.startsWith(to)).map((h) => `${h.holiday_date}|${h.name}`))
    let made = 0
    try {
      for (const h of source) {
        const date = moved(h.holiday_date)
        if (have.has(`${date}|${h.name}`)) continue
        await api.post('/leave/holidays', {
          holiday_date: date, name: h.name, description: h.description,
          is_optional: h.is_optional, is_active: h.is_active,
          holiday_type: h.holiday_type ?? 'public', branch_id: h.branch_id ?? null,
        })
        made += 1
      }
      window.alert(made ? `${made} holiday${made === 1 ? '' : 's'} copied to ${to}.` : `Nothing to copy: ${to} already has them.`)
      onDone(to)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The calendar could not be copied')
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Copy year"
      narrow
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={copy} disabled={busy || source.length === 0}>
            {busy ? 'Copying…' : `Copy ${source.length} holiday${source.length === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      <div className="crm-form">
        {error && <div className="crm-form-wide"><ErrorNote>{error}</ErrorNote></div>}
        <Field label="Copy from">
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {choices.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </Field>
        <Field label="Copy to">
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            {choices.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </Field>
        <p className="crm-sub crm-form-wide">
          {source.length === 0
            ? `${from} has no holidays to copy.`
            : 'Each holiday keeps its name, type and branch and moves to the same date in the new year. Check the festival dates afterwards: they change every year.'}
        </p>
      </div>
    </Dialog>
  )
}
