/* Leave Type Master — quotas, carry-forward and who each type is offered to.
 *
 * The same leave types Leave reads. "Days / year" is the yearly quota; a type that accrues
 * monthly keeps accruing monthly, at a twelfth of the figure. Who a type is offered to (by the
 * employee's recorded gender), the months of service before it is earned and the notice are
 * checked when somebody applies. Carrying forward is switched on per type; the most that carries
 * comes from Settings → Leave → Policy.
 */

import { useMemo, useState } from 'react'
import '../../styles/crm.css'
import '../../styles/org.css'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { canAdminister, useAuth } from '../../lib/auth'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconCalendar, IconEdit, IconPlus, IconSearch, IconTrash } from '../../components/Icons'
import { Dialog, Field } from '../crm/parts'
import type { LeaveSettingsOut, LeaveType } from '../hrms/leave/MyLeave'

const MILLI = 1000
const OFFERED: Record<string, string> = { all: 'Everyone', male: 'Male employees', female: 'Female employees' }

/** Days a year, whichever way the type accrues. */
const perYear = (t: LeaveType): number | null => {
  if (t.accrual_type === 'yearly') return t.accrual_rate_milli_days / MILLI
  if (t.accrual_type === 'monthly') return (t.accrual_rate_milli_days * 12) / MILLI
  return null
}
const carries = (t: LeaveType) => t.carry_forward_all || t.carry_forward_limit_milli_days > 0
const days = (n: number) => String(Math.round(n * 100) / 100)

export default function LeaveTypeMaster() {
  const { user } = useAuth()
  const isAdmin = canAdminister(user)
  const types = useQuery<LeaveType[]>('leave-type-master', () => api.get<LeaveType[]>('/leave/types?include_inactive=true'))
  const policy = useQuery<LeaveSettingsOut>('leave-policy', () => api.get<LeaveSettingsOut>('/leave/settings'))
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<LeaveType | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (types.data ?? []).filter((t) => !needle || t.name.toLowerCase().includes(needle) || (t.code ?? '').toLowerCase().includes(needle))
  }, [types.data, q])

  async function remove(type: LeaveType) {
    if (!window.confirm(`Deactivate “${type.name}”?\n\nLeave types are kept for the record, so it is switched off rather than deleted. Balances and past applications stay.`)) return
    setError(null)
    try {
      await api.put(`/leave/types/${type.id}`, { ...bodyOf(type), is_active: false })
      types.reload()
    } catch (err) {
      setError((err as { message?: string }).message ?? 'That leave type could not be changed')
    }
  }

  const total = types.data?.length ?? 0

  return (
    <div className="crm">
      <section className="card dm-card">
        <div className="dm-head">
          <span className="dm-tile dm-tile-green"><IconCalendar size={18} /></span>
          <div className="dm-heading">
            <h1 className="dm-title">Leave Type Master</h1>
            <p className="crm-sub">Quotas, carry-forward and who each type is offered to. Applied once Leave is live.</p>
          </div>
          <div className="dm-tools">
            <div className="crm-search dm-search">
              <IconSearch size={15} />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search leave types…" aria-label="Search leave types" />
            </div>
            <span className="crm-sub crm-nowrap">{total} leave type{total === 1 ? '' : 's'}</span>
            {isAdmin && (
              <button className="btn btn-primary" onClick={() => setEditing('new')}>
                <IconPlus size={15} /> Add Leave Type
              </button>
            )}
          </div>
        </div>

        {(error || types.error) && <div className="dm-error"><ErrorNote>{error ?? types.error}</ErrorNote></div>}

        {types.loading && !types.data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState
            title={q ? 'No leave type matches that search' : 'No leave types yet'}
            body={q ? 'Try a different name or code.' : 'Add Casual, Sick and Earned leave, or whatever your company offers.'}
            action={isAdmin && !q ? <button className="btn btn-primary" onClick={() => setEditing('new')}>Add the first one</button> : undefined}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Leave type</th><th>Per year</th><th>Per month</th><th>Carry fwd</th><th>Half day</th><th>Status</th>
                  {isAdmin && <th style={{ textAlign: 'right' }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const year = perYear(t)
                  return (
                    <tr key={t.id}>
                      <td>
                        <span className="lt-badge" style={{ color: t.color ?? '#0ea5e9', background: `${t.color ?? '#0ea5e9'}22` }}>
                          {(t.code ?? t.name.slice(0, 2)).toUpperCase()}
                        </span>
                        <span className="lt-names">
                          <span className="crm-strong">{t.name}</span>
                          <span className="crm-sub">
                            {t.is_paid ? 'Paid' : 'Unpaid'}{t.offered_to && t.offered_to !== 'all' ? ` · ${OFFERED[t.offered_to]}` : ''}
                          </span>
                        </span>
                      </td>
                      <td className="crm-strong">{year === null ? '–' : days(year)}</td>
                      <td className="crm-muted sm-mono">{t.max_per_month_milli_days ? `${days(t.max_per_month_milli_days / MILLI)} days` : 'No limit'}</td>
                      <td className="crm-muted">
                        {t.carry_forward_all ? 'All' : t.carry_forward_limit_milli_days > 0 ? `Up to ${days(t.carry_forward_limit_milli_days / MILLI)}` : 'No'}
                      </td>
                      <td className="crm-muted">{t.allow_half_day ? 'Yes' : 'No'}</td>
                      <td>
                        <span className={`crm-state ${t.is_active ? 'crm-state-good' : 'crm-state-idle'}`}>{t.is_active ? 'Active' : 'Inactive'}</span>
                      </td>
                      {isAdmin && (
                        <td>
                          <div className="crm-row-actions">
                            <button className="crm-icon-btn" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`} title="Edit"><IconEdit size={16} /></button>
                            {t.is_active && (
                              <button className="crm-icon-btn dm-delete" onClick={() => remove(t)} aria-label={`Deactivate ${t.name}`} title="Deactivate"><IconTrash size={16} /></button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && (
        <LeaveTypeDialog
          type={editing === 'new' ? null : editing}
          carryMaxMilli={policy.data?.carry_forward_max_milli_days ?? 15000}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); types.reload() }}
        />
      )}
    </div>
  )
}

/** Every field the API takes, from a type as it is stored, so an edit that touches some of them
 *  sends back the rest unchanged. */
function bodyOf(t: LeaveType) {
  return {
    name: t.name, code: t.code, description: t.description, is_paid: t.is_paid,
    accrual_type: t.accrual_type, accrual_rate_milli_days: t.accrual_rate_milli_days,
    max_balance_milli_days: t.max_balance_milli_days,
    carry_forward_limit_milli_days: t.carry_forward_limit_milli_days, carry_forward_all: t.carry_forward_all,
    min_notice_days: t.min_notice_days, requires_approval: t.requires_approval, allow_half_day: t.allow_half_day,
    is_comp_off: t.is_comp_off, is_encashable: t.is_encashable, is_active: t.is_active,
    color: t.color ?? '#0ea5e9', offered_to: t.offered_to ?? 'all', min_service_months: t.min_service_months ?? 0,
    proof_after_days: t.proof_after_days ?? 0, max_per_month_milli_days: t.max_per_month_milli_days ?? 0,
  }
}

function LeaveTypeDialog({
  type, carryMaxMilli, onClose, onSaved,
}: {
  type: LeaveType | null
  carryMaxMilli: number
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    name: type?.name ?? '',
    code: type?.code ?? '',
    days: type ? (perYear(type) === null ? '0' : days(perYear(type) as number)) : '12',
    perMonth: type?.max_per_month_milli_days ? days(type.max_per_month_milli_days / MILLI) : '0',
    color: type?.color ?? '#0ea5e9',
    offered_to: (type?.offered_to ?? 'all') as string,
    notice: String(type?.min_notice_days ?? 0),
    service: String(type?.min_service_months ?? 0),
    proof: String(type?.proof_after_days ?? 0),
    is_paid: type?.is_paid ?? true,
    half: type?.allow_half_day ?? true,
    carry: type ? carries(type) : false,
    encash: type?.is_encashable ?? false,
    is_active: type?.is_active ?? true,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  async function save() {
    if (!form.name.trim()) return setError('Give the leave type a name.')
    const yearDays = Number(form.days)
    const monthDays = Number(form.perMonth)
    const whole = (v: string, max: number) => v.trim() !== '' && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= max
    if (!(yearDays >= 0 && yearDays <= 365)) return setError('Days a year is between 0 and 365.')
    if (!(monthDays >= 0 && monthDays <= 31)) return setError('Max a month is between 0 and 31 days.')
    if (!whole(form.notice, 365)) return setError('Notice days is a whole number, 0 to 365.')
    if (!whole(form.service, 120)) return setError('Minimum service is a whole number of months, 0 to 120.')
    if (!whole(form.proof, 365)) return setError('Proof after is a whole number of days, 0 to 365.')

    // How the yearly figure is stored depends on how the type already accrues: a monthly type stays
    // monthly (a twelfth a month), anything else credits the year's quota in one go. A type that
    // is not accrued at all (comp-off, loss of pay) stays that way unless given a quota.
    const was = type?.accrual_type
    let accrual_type: 'monthly' | 'yearly' | 'none' = was ?? 'yearly'
    let rate = Math.round(yearDays * MILLI)
    if (yearDays === 0) { accrual_type = 'none'; rate = 0 }
    else if (was === 'monthly') rate = Math.round((yearDays * MILLI) / 12)
    else if (was === 'none') accrual_type = type?.is_comp_off ? 'none' : 'yearly'
    if (type?.is_comp_off) { accrual_type = 'none'; rate = 0 }

    // Turning carry-forward on gives the type the policy's maximum; leaving it as it was keeps a custom limit.
    const was_carry = type ? carries(type) : false
    const carry = form.carry
      ? (was_carry ? { carry_forward_limit_milli_days: type!.carry_forward_limit_milli_days, carry_forward_all: type!.carry_forward_all }
        : { carry_forward_limit_milli_days: carryMaxMilli, carry_forward_all: false })
      : { carry_forward_limit_milli_days: 0, carry_forward_all: false }

    setBusy(true)
    setError(null)
    const base = type ? bodyOf(type) : {
      description: null, max_balance_milli_days: 0, requires_approval: true, is_comp_off: false,
    }
    const body = {
      ...base,
      name: form.name.trim(),
      code: form.code.trim() || null,
      is_paid: form.is_paid,
      accrual_type,
      accrual_rate_milli_days: rate,
      ...carry,
      min_notice_days: Number(form.notice),
      allow_half_day: form.half,
      is_encashable: form.encash,
      is_active: form.is_active,
      color: form.color,
      offered_to: form.offered_to,
      min_service_months: Number(form.service),
      proof_after_days: Number(form.proof),
      max_per_month_milli_days: Math.round(monthDays * MILLI),
    }
    try {
      if (type) await api.put(`/leave/types/${type.id}`, body)
      else await api.post('/leave/types', body)
      onSaved()
    } catch (err) {
      setError((err as { message?: string }).message ?? 'That leave type could not be saved')
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={type ? `Edit ${type.name}` : 'Add Leave Type'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.name.trim()}>
            {busy ? 'Saving…' : type ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      <div className="crm-form">
        {error && <div className="crm-form-wide"><ErrorNote>{error}</ErrorNote></div>}
        <div className="crm-form-wide lt-row-5">
          <Field label="Name" required>
            <input value={form.name} placeholder="Casual Leave" autoFocus onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Short" hint="Calendar cell">
            <input value={form.code} maxLength={16} placeholder="CL" onChange={(e) => set({ code: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Days / year">
            <input type="number" data-spin min={0} step="any" value={form.days} onChange={(e) => set({ days: e.target.value })} />
          </Field>
          <Field label="Max / month" hint="0 — no monthly ceiling">
            <input type="number" data-spin min={0} step="any" value={form.perMonth} onChange={(e) => set({ perMonth: e.target.value })} />
          </Field>
          <Field label="Offered to">
            <select value={form.offered_to} onChange={(e) => set({ offered_to: e.target.value })}>
              {Object.entries(OFFERED).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
        </div>

        <div className="crm-form-wide lt-row-3">
          <Field label="Notice days" hint="0 = same day">
            <input type="number" data-spin min={0} step={1} value={form.notice} onChange={(e) => set({ notice: e.target.value })} />
          </Field>
          <Field label="Min service (mo)" hint="Before it is earned">
            <input type="number" data-spin min={0} step={1} value={form.service} onChange={(e) => set({ service: e.target.value })} />
          </Field>
          <Field label="Proof after (days)" hint="0 = never">
            <input type="number" data-spin min={0} step={1} value={form.proof} onChange={(e) => set({ proof: e.target.value })} />
          </Field>
        </div>

        <div className="crm-form-wide lt-checks">
          <label className="crm-check"><input type="checkbox" checked={form.is_paid} onChange={(e) => set({ is_paid: e.target.checked })} /> Paid leave</label>
          <label className="crm-check"><input type="checkbox" checked={form.half} onChange={(e) => set({ half: e.target.checked })} /> Half days can be applied for</label>
          <label className="crm-check"><input type="checkbox" checked={form.carry} onChange={(e) => set({ carry: e.target.checked })} /> Unused days carry into next year</label>
          <label className="crm-check"><input type="checkbox" checked={form.encash} onChange={(e) => set({ encash: e.target.checked })} /> Can be encashed</label>
          <label className="crm-check"><input type="checkbox" checked={form.is_active} onChange={(e) => set({ is_active: e.target.checked })} /> Active</label>
        </div>

        <div className="crm-form-wide">
          <span className="crm-field-label">Colour</span>
          <input type="color" className="sm-color" value={form.color} onChange={(e) => set({ color: e.target.value })} aria-label="Colour" />
        </div>
      </div>
    </Dialog>
  )
}
