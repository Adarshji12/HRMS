import { useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { canAdminister, useAuth } from '../../../lib/auth'
import { shortDate, todayISO } from '../../../lib/format'
import { Empty, EmptyState, ErrorNote, Loading } from '../../../components/ui'
import Tabs, { TabPanel } from '../../../components/Tabs'
import {
  MILLI_DAYS_PER_DAY,
  MONTHS,
  days,
  errorText,
  type Holiday,
  type LeaveSettingsOut,
  type LeaveType,
} from './MyLeave'
import '../../../styles/leave.css'

/**
 * Leave Settings — leave types, the holiday calendar, and the leave year.
 *
 * Two zeroes on this screen mean opposite things, and both are labelled in
 * words next to the input rather than left to the reader's memory:
 *
 *   * `carry_forward_limit_milli_days = 0` — carry **nothing**. Use it or lose
 *     it. "Carry everything" is a separate boolean, not a very large number.
 *   * `optional_holiday_quota = 0` — **unlimited**. An employee may opt into
 *     every optional holiday there is.
 *
 * `max_balance_milli_days = 0` is a third zero and means uncapped, which is at
 * least on the same side as the quota. All three are echoed live.
 */

type Section = 'types' | 'holidays' | 'year'

/** Which policy year a date falls in. Mirrors `svc.policy_year_for`: an org on
 *  an April start books March 2027 as year 2026, and reading it as the year the
 *  policy year *ends* in is an off-by-one worth somebody's whole balance. */
function policyYearFor(iso: string, startMonth: number): number {
  const year = Number(iso.slice(0, 4))
  const month = Number(iso.slice(5, 7))
  return month >= startMonth ? year : year - 1
}

function policyYearLabel(year: number, startMonth: number): string {
  if (startMonth === 1) return `${year}`
  return `${MONTHS[startMonth - 1]} ${year} – ${MONTHS[(startMonth + 10) % 12]} ${year + 1}`
}

/** Days typed in a form → integer milli-days on the wire.
 *
 *  The float lives only inside the number input, because "1.5 days" is how a
 *  policy is written down. It is rounded to an integer once, here, and never
 *  arithmetic'd afterwards — same shape as the hours→minutes conversion in
 *  `Timesheets.tsx`. */
function toMilli(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.round(value * MILLI_DAYS_PER_DAY)
}

/** Integer milli-days → the number to put back in a days input. Display only. */
function toDaysInput(milli: number): number {
  return milli / MILLI_DAYS_PER_DAY
}

export default function LeaveSettings() {
  const { user } = useAuth()
  const isAdmin = canAdminister(user)
  const [section, setSection] = useState<Section>('types')
  const [reloadKey, setReloadKey] = useState(0)
  const [notice, setNotice] = useState<ReactNode>(null)

  const settings = useQuery<LeaveSettingsOut>(`leave-settings:${reloadKey}`, () =>
    api.get<LeaveSettingsOut>('/leave/settings'),
  )
  const types = useQuery<LeaveType[]>(`leave-types-all:${reloadKey}`, () =>
    api.get<LeaveType[]>('/leave/types?include_inactive=true'),
  )

  function done(message: ReactNode) {
    setNotice(message)
    setReloadKey((n) => n + 1)
  }

  if (!isAdmin) {
    return (
      <div>
        <div className="page-head">
          <h1 className="page-title">Leave Settings</h1>
        </div>
        <section className="card">
          <EmptyState
            title="Administrators only"
            body="Leave types, the holiday calendar and the leave year are org-wide policy. Your own balances and applications are on My Leave."
          />
        </section>
      </div>
    )
  }

  const error = settings.error ?? types.error
  if (error) return <ErrorNote>{errorText(error)}</ErrorNote>
  if (settings.loading || types.loading || !settings.data || !types.data) return <Loading />

  const resolved = settings.data

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Leave Settings</h1>
          <p className="page-sub">
            What leave exists, when the days are, and when the year turns over.
          </p>
        </div>
      </div>

      {notice && <div className="notice notice-ok" style={{ marginBottom: 14 }}>{notice}</div>}

      <Tabs<Section>
        label="Leave settings"
        value={section}
        onChange={(id) => { setSection(id); setNotice(null) }}
        items={[
          { id: 'types', label: 'Leave types', badge: types.data.filter((t) => t.is_active).length },
          { id: 'holidays', label: 'Holiday calendar' },
          { id: 'year', label: 'Leave year', badge: resolved.is_configured ? undefined : 'unset' },
        ]}
      />

      <div className="lv-tab-body">
        {section === 'types' && (
          <TabPanel id="types">
            <TypesPanel types={types.data} onDone={done} />
          </TabPanel>
        )}
        {section === 'holidays' && (
          <TabPanel id="holidays">
            <HolidaysPanel settings={resolved} onDone={done} />
          </TabPanel>
        )}
        {section === 'year' && (
          <TabPanel id="year">
            <YearPanel settings={resolved} onDone={done} />
          </TabPanel>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ leave year -- */

function YearPanel({
  settings,
  onDone,
}: {
  settings: LeaveSettingsOut
  onDone: (message: ReactNode) => void
}) {
  const [month, setMonth] = useState(settings.leave_year_start_month)
  const [quota, setQuota] = useState(settings.optional_holiday_quota)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const thisYear = policyYearFor(todayISO(), month)

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.put<LeaveSettingsOut>('/leave/settings', {
        leave_year_start_month: month,
        optional_holiday_quota: quota,
      })
      onDone(
        <>
          <b>Leave year saved.</b> Balances now open in {MONTHS[month - 1]}, and optional-holiday
          opt-ins are{' '}
          {quota === 0 ? 'unlimited' : `capped at ${quota} per employee`}. This is a recorded
          decision now, not a default.
        </>,
      )
    } catch (err) {
      setError(errorText(err, 'Could not save the leave year'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      {!settings.is_configured && (
        <div className="lv-unset">
          <b>Nobody has set this yet.</b> There is no leave-settings record for this organisation,
          which is a legal state and means the defaults are in force: the leave year opens in{' '}
          <b>January</b>, and optional-holiday opt-ins are <b>unlimited</b>. Those are fallbacks,
          not choices somebody made. Saving below turns them into a decision — including saving
          them exactly as they are.
        </div>
      )}
      {settings.is_configured && (
        <div className="notice" style={{ marginBottom: 16 }}>
          <b>Configured.</b> An administrator chose these values; they are not the fallbacks.
        </div>
      )}

      <form onSubmit={save}>
        <div className="settings-grid">
          <label className="setting">
            Leave year starts in
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTHS.map((name, index) => (
                <option key={name} value={index + 1}>{name}</option>
              ))}
            </select>
            <span className="setting-hint">
              This is the month a balance year <i>opens</i> in. Many organisations run April to
              March; the default is a plain calendar year.
            </span>
            <div className="lv-year-preview">
              Today falls in policy year <b>{thisYear}</b> — {policyYearLabel(thisYear, month)}.
              {month !== 1 && (
                <>
                  {' '}
                  Note that {MONTHS[(month + 10) % 12]} {thisYear + 1} is booked as year{' '}
                  <b>{thisYear}</b>, not {thisYear + 1}.
                </>
              )}
            </div>
          </label>

          <label className="setting">
            Optional holidays each employee may take
            <input
              type="number"
              min={0}
              max={50}
              step={1}
              value={quota}
              onChange={(e) => setQuota(Math.max(0, Math.min(50, Number(e.target.value) || 0)))}
            />
            <div className={`lv-zero${quota === 0 ? ' lv-zero-strong' : ''}`}>
              {quota === 0 ? (
                <>
                  <b>0 here means UNLIMITED</b> — every employee may opt into every optional
                  holiday on the calendar. It does not mean “none”. To allow none, mark no
                  holiday as optional.
                </>
              ) : (
                <>Each employee may opt into at most <b>{quota}</b> of the optional holidays.</>
              )}
            </div>
            <span className="setting-hint">
              An optional holiday is only a day off for the employees who chose it; everyone else
              is expected in. They pick their set on their own calendar, all at once.
            </span>
          </label>
        </div>

        {error && <div style={{ marginTop: 14 }}><ErrorNote>{error}</ErrorNote></div>}

        <div style={{ marginTop: 16 }}>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : settings.is_configured ? 'Save leave year' : 'Record these as chosen'}
          </button>
        </div>
      </form>
    </section>
  )
}

/* ----------------------------------------------------------- leave types -- */

interface TypeDraft {
  name: string
  code: string
  description: string
  is_paid: boolean
  accrual_type: 'monthly' | 'yearly' | 'none'
  accrual_rate_days: number
  max_balance_days: number
  carry_forward_days: number
  carry_forward_all: boolean
  min_notice_days: number
  requires_approval: boolean
  allow_half_day: boolean
  is_comp_off: boolean
  is_encashable: boolean
  is_active: boolean
}

const BLANK_TYPE: TypeDraft = {
  name: '',
  code: '',
  description: '',
  is_paid: true,
  accrual_type: 'monthly',
  accrual_rate_days: 1.5,
  max_balance_days: 0,
  carry_forward_days: 0,
  carry_forward_all: false,
  min_notice_days: 0,
  requires_approval: true,
  allow_half_day: true,
  is_comp_off: false,
  is_encashable: false,
  is_active: true,
}

function formFor(leaveType: LeaveType): TypeDraft {
  return {
    name: leaveType.name,
    code: leaveType.code ?? '',
    description: leaveType.description ?? '',
    is_paid: leaveType.is_paid,
    accrual_type: leaveType.accrual_type,
    accrual_rate_days: toDaysInput(leaveType.accrual_rate_milli_days),
    max_balance_days: toDaysInput(leaveType.max_balance_milli_days),
    carry_forward_days: toDaysInput(leaveType.carry_forward_limit_milli_days),
    carry_forward_all: leaveType.carry_forward_all,
    min_notice_days: leaveType.min_notice_days,
    requires_approval: leaveType.requires_approval,
    allow_half_day: leaveType.allow_half_day,
    is_comp_off: leaveType.is_comp_off,
    is_encashable: leaveType.is_encashable,
    is_active: leaveType.is_active,
  }
}

/** In words, because the number alone is ambiguous in both directions. */
function carryForwardText(leaveType: LeaveType): string {
  if (leaveType.carry_forward_all) return 'Everything carries over'
  if (leaveType.carry_forward_limit_milli_days === 0) return 'Nothing — use it or lose it'
  return `Up to ${days(leaveType.carry_forward_limit_milli_days)} days`
}

function TypesPanel({
  types,
  onDone,
}: {
  types: LeaveType[]
  onDone: (message: ReactNode) => void
}) {
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const hasCompOff = types.some((t) => t.is_comp_off)

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Leave types</h2>
        <button className="btn btn-sm" onClick={() => setEditing(editing === 'new' ? null : 'new')}>
          {editing === 'new' ? 'Cancel' : 'New leave type'}
        </button>
      </div>

      {editing === 'new' && (
        <TypeForm
          initial={BLANK_TYPE}
          compOffTaken={hasCompOff}
          onCancel={() => setEditing(null)}
          onSaved={(name) => {
            setEditing(null)
            onDone(<><b>{name}</b> created. Employees can apply for it straight away.</>)
          }}
        />
      )}

      {types.length === 0 ? (
        <EmptyState
          title="No leave types yet"
          body={
            <>
              Nothing works until at least one exists — no balances, no applications, no
              approvals. Most organisations start with three: <b>Casual Leave</b> and{' '}
              <b>Sick Leave</b> accruing monthly, and <b>Earned Leave</b> accruing yearly with a
              carry-forward limit. Add a comp-off type later if you grant days back for weekend
              work.
            </>
          }
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Accrual</th>
                <th>Max balance</th>
                <th>Carry-forward</th>
                <th>Notice</th>
                <th>Half day</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {types.map((leaveType) => [
                <tr key={leaveType.id} className={leaveType.is_active ? undefined : 'lv-past'}>
                  <td>
                    <b>{leaveType.name}</b>
                    {leaveType.code && <span className="badge" style={{ marginLeft: 8 }}>{leaveType.code}</span>}
                    <div className="lv-sub">
                      {leaveType.is_paid ? 'Paid' : 'Unpaid'}
                      {leaveType.is_comp_off && ' · comp-off'}
                      {leaveType.is_encashable && ' · encashable'}
                      {!leaveType.requires_approval && ' · no approval needed'}
                      {!leaveType.is_active && ' · inactive'}
                    </div>
                  </td>
                  <td>
                    {leaveType.is_comp_off ? (
                      <span className="lv-sub">From comp-off credits only</span>
                    ) : leaveType.accrual_type === 'none' ? (
                      <span className="lv-sub">Granted by hand</span>
                    ) : (
                      <>
                        {days(leaveType.accrual_rate_milli_days)} / {leaveType.accrual_type === 'monthly' ? 'month' : 'year'}
                      </>
                    )}
                  </td>
                  <td>
                    {leaveType.max_balance_milli_days === 0 ? (
                      <span className="lv-sub">Uncapped (0)</span>
                    ) : (
                      `${days(leaveType.max_balance_milli_days)} days`
                    )}
                  </td>
                  <td>{carryForwardText(leaveType)}</td>
                  <td className="num lv-mono">{leaveType.min_notice_days || '—'}</td>
                  <td>{leaveType.allow_half_day ? 'Allowed' : 'No'}</td>
                  <td className="num">
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => setEditing(editing === leaveType.id ? null : leaveType.id)}
                    >
                      {editing === leaveType.id ? 'Close' : 'Edit'}
                    </button>
                  </td>
                </tr>,
                editing === leaveType.id ? (
                  <tr key={`${leaveType.id}-edit`}>
                    <td colSpan={7}>
                      <TypeForm
                        initial={formFor(leaveType)}
                        id={leaveType.id}
                        compOffTaken={hasCompOff && !leaveType.is_comp_off}
                        onCancel={() => setEditing(null)}
                        onSaved={(name) => {
                          setEditing(null)
                          onDone(
                            <>
                              <b>{name}</b> updated. Leave already applied for keeps the duration
                              it was frozen with.
                            </>,
                          )
                        }}
                      />
                    </td>
                  </tr>
                ) : null,
              ])}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function TypeForm({
  initial,
  id,
  compOffTaken,
  onCancel,
  onSaved,
}: {
  initial: TypeDraft
  id?: string
  compOffTaken: boolean
  onCancel: () => void
  onSaved: (name: string) => void
}) {
  const [form, setForm] = useState<TypeDraft>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function patch(next: Partial<TypeDraft>) {
    setForm((prev) => {
      const merged = { ...prev, ...next }
      /* A comp-off type never accrues on a schedule — its balance is a
         projection of the credit ledger, and a second writer is exactly what
         D-022 exists to prevent. The server refuses this combination with a
         422; the form should not offer it. */
      if (merged.is_comp_off) merged.accrual_type = 'none'
      return merged
    })
  }

  const rateNeeded = form.accrual_type !== 'none'
  const rateMissing = rateNeeded && form.accrual_rate_days <= 0

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (rateMissing) {
      setError(
        'A monthly or yearly type must accrue something. Set a rate, or choose “granted by hand” ' +
          'if it is topped up manually — a scheduled type with a zero rate looks to the employee ' +
          'exactly like a broken accrual job.',
      )
      return
    }
    setBusy(true)
    setError(null)
    const payload = {
      name: form.name.trim(),
      code: form.code.trim() || null,
      description: form.description.trim() || null,
      is_paid: form.is_paid,
      accrual_type: form.accrual_type,
      accrual_rate_milli_days: form.accrual_type === 'none' ? 0 : toMilli(form.accrual_rate_days),
      max_balance_milli_days: toMilli(form.max_balance_days),
      carry_forward_limit_milli_days: toMilli(form.carry_forward_days),
      carry_forward_all: form.carry_forward_all,
      min_notice_days: Math.max(0, Math.round(form.min_notice_days)),
      requires_approval: form.requires_approval,
      allow_half_day: form.allow_half_day,
      is_comp_off: form.is_comp_off,
      is_encashable: form.is_encashable,
      is_active: form.is_active,
    }
    try {
      if (id) await api.put<LeaveType>(`/leave/types/${id}`, payload)
      else await api.post<LeaveType>('/leave/types', payload)
      onSaved(payload.name)
    } catch (err) {
      setError(errorText(err, 'Could not save that leave type'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="lv-form" onSubmit={submit}>
      {error && <div style={{ marginBottom: 12 }}><ErrorNote>{error}</ErrorNote></div>}

      <div className="settings-grid">
        <label className="setting">
          Name
          <input
            value={form.name}
            maxLength={120}
            required
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="Casual Leave"
          />
        </label>
        <label className="setting">
          Short code <span className="setting-hint">Optional. Shows next to the balance.</span>
          <input
            value={form.code}
            maxLength={16}
            onChange={(e) => patch({ code: e.target.value })}
            placeholder="CL"
          />
        </label>

        <label className="setting">
          Accrues
          <select
            value={form.accrual_type}
            disabled={form.is_comp_off}
            onChange={(e) => patch({ accrual_type: e.target.value as TypeDraft['accrual_type'] })}
          >
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
            <option value="none">Not on a schedule — granted by hand</option>
          </select>
          {form.is_comp_off && (
            <span className="setting-hint">
              Fixed for a comp-off type: its balance comes from comp-off credits, which are its
              only writer.
            </span>
          )}
        </label>

        {rateNeeded && (
          <label className="setting">
            Rate, in days per {form.accrual_type === 'monthly' ? 'month' : 'year'}
            <input
              type="number"
              min={0}
              step={0.25}
              value={form.accrual_rate_days}
              onChange={(e) => patch({ accrual_rate_days: Number(e.target.value) })}
            />
            <span className="setting-hint">
              Stored as {toMilli(form.accrual_rate_days)} milli-days — a thousandth of a day, so
              half days are exact.
            </span>
          </label>
        )}

        <label className="setting">
          Maximum balance, in days
          <input
            type="number"
            min={0}
            step={0.5}
            value={form.max_balance_days}
            onChange={(e) => patch({ max_balance_days: Number(e.target.value) })}
          />
          <div className={`lv-zero${form.max_balance_days === 0 ? ' lv-zero-strong' : ''}`}>
            {form.max_balance_days === 0
              ? '0 here means UNCAPPED — the balance keeps accruing with no ceiling.'
              : `Accrual stops once the balance reaches ${form.max_balance_days} days.`}
          </div>
        </label>

        <div className="setting">
          Carry-forward at the end of the leave year
          <label className="check-field" style={{ marginBottom: 6 }}>
            <input
              type="checkbox"
              checked={form.carry_forward_all}
              onChange={(e) => patch({ carry_forward_all: e.target.checked })}
            />
            <span>Carry everything over</span>
          </label>
          {!form.carry_forward_all && (
            <>
              <input
                type="number"
                min={0}
                step={0.5}
                value={form.carry_forward_days}
                onChange={(e) => patch({ carry_forward_days: Number(e.target.value) })}
              />
              <div className={`lv-zero${form.carry_forward_days === 0 ? ' lv-zero-strong' : ''}`}>
                {form.carry_forward_days === 0 ? (
                  <>
                    <b>0 here means NOTHING carries over</b> — use it or lose it. This is the
                    opposite of the zero on “maximum balance”. To carry everything, tick the box
                    above rather than typing a large number.
                  </>
                ) : (
                  <>At most <b>{form.carry_forward_days}</b> days follow the employee into the next leave year; the rest lapses.</>
                )}
              </div>
            </>
          )}
        </div>

        <label className="setting">
          Notice required, in days
          <input
            type="number"
            min={0}
            max={365}
            step={1}
            value={form.min_notice_days}
            onChange={(e) => patch({ min_notice_days: Number(e.target.value) })}
          />
          <span className="setting-hint">
            Enforced on the employee, waived for anyone filing on their behalf — HR back-filling
            last month from a spreadsheet has to be possible. 0 for no notice.
          </span>
        </label>
      </div>

      <div className="filter-row" style={{ marginTop: 14, marginBottom: 0 }}>
        <label className="check-field">
          <input type="checkbox" checked={form.is_paid} onChange={(e) => patch({ is_paid: e.target.checked })} />
          <span>Paid</span>
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={form.requires_approval}
            onChange={(e) => patch({ requires_approval: e.target.checked })}
          />
          <span>Needs approval</span>
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={form.allow_half_day}
            onChange={(e) => patch({ allow_half_day: e.target.checked })}
          />
          <span>Half days allowed</span>
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={form.is_comp_off}
            disabled={compOffTaken}
            onChange={(e) => patch({ is_comp_off: e.target.checked })}
          />
          <span>This is the comp-off type</span>
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={form.is_encashable}
            onChange={(e) => patch({ is_encashable: e.target.checked })}
          />
          <span>Encashable on exit</span>
        </label>
        <label className="check-field">
          <input type="checkbox" checked={form.is_active} onChange={(e) => patch({ is_active: e.target.checked })} />
          <span>Active</span>
        </label>
      </div>

      {compOffTaken && (
        <p className="setting-hint" style={{ marginTop: 8 }}>
          This organisation already has a comp-off type, and there can only be one — two would
          give the credit ledger two balances to keep in step.
        </p>
      )}
      {form.is_encashable && (
        <p className="setting-hint" style={{ marginTop: 8 }}>
          An unused balance of this type is paid out in the full-and-final settlement, at
          basic ÷ 26 by default. Earned leave is normally encashable; casual and sick leave
          normally are not.
        </p>
      )}
      {!form.requires_approval && (
        <p className="setting-hint" style={{ marginTop: 8 }}>
          Without approval this type is a declaration: applying debits the balance immediately and
          nothing lands in a manager’s queue.
        </p>
      )}

      <label className="setting" style={{ marginTop: 14 }}>
        Description <span className="setting-hint">Optional. Shown to employees.</span>
        <textarea
          className="set-textarea"
          value={form.description}
          maxLength={2000}
          onChange={(e) => patch({ description: e.target.value })}
        />
      </label>

      <div className="lv-actions" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy || !form.name.trim()}>
          {busy ? 'Saving…' : id ? 'Save changes' : 'Create leave type'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/* ------------------------------------------------------- holiday calendar -- */

interface HolidayDraft {
  holiday_date: string
  name: string
  description: string
  is_optional: boolean
  is_active: boolean
}

function HolidaysPanel({
  settings,
  onDone,
}: {
  settings: LeaveSettingsOut
  onDone: (message: ReactNode) => void
}) {
  const currentYear = policyYearFor(todayISO(), settings.leave_year_start_month)
  const [year, setYear] = useState(currentYear)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const holidays = useQuery<Holiday[]>(`leave-holidays:${year}:${reloadKey}`, () =>
    api.get<Holiday[]>(`/leave/holidays?year=${year}&include_inactive=true`),
  )

  function done(message: ReactNode) {
    setEditing(null)
    setReloadKey((n) => n + 1)
    onDone(message)
  }

  const rows = holidays.data ?? []
  const optional = rows.filter((h) => h.is_optional && h.is_active)

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Holiday calendar</h2>
        <div className="card-tools">
          <label className="field">
            Policy year
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {[currentYear - 1, currentYear, currentYear + 1].map((y) => (
                <option key={y} value={y}>{policyYearLabel(y, settings.leave_year_start_month)}</option>
              ))}
            </select>
          </label>
          <button className="btn btn-sm" onClick={() => setEditing(editing === 'new' ? null : 'new')}>
            {editing === 'new' ? 'Cancel' : 'Add holiday'}
          </button>
        </div>
      </div>

      <p className="lv-note" style={{ marginTop: -4, marginBottom: 14 }}>
        A holiday inside a leave range is skipped, so it does not spend balance. Editing this
        calendar changes what <i>future</i> applications cost and nothing else — anything already
        applied for keeps the duration frozen onto it.
        {optional.length > 0 && (
          <>
            {' '}
            {optional.length} of these are optional, and{' '}
            {settings.optional_holidays_are_unlimited ? (
              <b>each employee may opt into all of them (quota 0 = unlimited)</b>
            ) : (
              <b>each employee may opt into {settings.optional_holiday_quota} of them</b>
            )}
            . An optional holiday is not a day off for anyone who did not choose it.
          </>
        )}
      </p>

      {editing === 'new' && (
        <HolidayForm
          initial={{
            holiday_date: todayISO(),
            name: '',
            description: '',
            is_optional: false,
            is_active: true,
          }}
          onCancel={() => setEditing(null)}
          onSaved={(name) => done(<><b>{name}</b> added to the calendar.</>)}
        />
      )}

      {holidays.loading ? (
        <Loading />
      ) : holidays.error ? (
        <ErrorNote>{errorText(holidays.error)}</ErrorNote>
      ) : rows.length === 0 ? (
        <EmptyState
          title={`No holidays in ${policyYearLabel(year, settings.leave_year_start_month)}`}
          body={
            <>
              A new organisation starts with an empty calendar, which means every date costs
              balance. Add the public holidays for this year first, then mark any restricted or
              festival days as <b>optional</b> so employees can choose between them.
            </>
          }
        />
      ) : (
        <div className={`table-wrap${holidays.refetching ? ' refetching' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Holiday</th>
                <th>Kind</th>
                <th className="num">Opted in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((holiday) => [
                <tr
                  key={holiday.id}
                  className={
                    !holiday.is_active
                      ? 'lv-past'
                      : holiday.is_optional
                        ? 'lv-holiday-optional'
                        : undefined
                  }
                >
                  <td className="lv-mono">
                    <b>{shortDate(holiday.holiday_date)}</b>
                    <div className="lv-sub">{holiday.holiday_date}</div>
                  </td>
                  <td>
                    {holiday.name}
                    {holiday.description && <div className="lv-sub">{holiday.description}</div>}
                  </td>
                  <td>
                    {holiday.is_optional ? (
                      <span className="badge badge-warn">Optional</span>
                    ) : (
                      <span className="badge">Everyone</span>
                    )}
                    {!holiday.is_active && <span className="badge" style={{ marginLeft: 6 }}>Inactive</span>}
                  </td>
                  <td className="num lv-mono">
                    {holiday.is_optional ? (holiday.opt_in_count ?? 0) : '—'}
                  </td>
                  <td className="num">
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => setEditing(editing === holiday.id ? null : holiday.id)}
                    >
                      {editing === holiday.id ? 'Close' : 'Edit'}
                    </button>
                  </td>
                </tr>,
                editing === holiday.id ? (
                  <tr key={`${holiday.id}-edit`}>
                    <td colSpan={5}>
                      <HolidayForm
                        id={holiday.id}
                        initial={{
                          holiday_date: holiday.holiday_date,
                          name: holiday.name,
                          description: holiday.description ?? '',
                          is_optional: holiday.is_optional,
                          is_active: holiday.is_active,
                        }}
                        optInCount={holiday.opt_in_count ?? 0}
                        onCancel={() => setEditing(null)}
                        onSaved={(name) => done(<><b>{name}</b> updated.</>)}
                        onDeleted={(name) => done(<><b>{name}</b> removed from the calendar.</>)}
                      />
                    </td>
                  </tr>
                ) : null,
              ])}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && optional.length === 0 && (
        <Empty>
          No optional holidays this year. Mark a holiday optional when it is one of several
          festival days people choose between rather than a day the whole company is closed.
        </Empty>
      )}
    </section>
  )
}

function HolidayForm({
  initial,
  id,
  optInCount = 0,
  onCancel,
  onSaved,
  onDeleted,
}: {
  initial: HolidayDraft
  id?: string
  optInCount?: number
  onCancel: () => void
  onSaved: (name: string) => void
  onDeleted?: (name: string) => void
}) {
  const [form, setForm] = useState<HolidayDraft>(initial)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const payload = {
      holiday_date: form.holiday_date,
      name: form.name.trim(),
      description: form.description.trim() || null,
      is_optional: form.is_optional,
      is_active: form.is_active,
    }
    try {
      if (id) await api.put<Holiday>(`/leave/holidays/${id}`, payload)
      else await api.post<Holiday>('/leave/holidays', payload)
      onSaved(payload.name)
    } catch (err) {
      setError(errorText(err, 'Could not save that holiday'))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!id) return
    setBusy(true)
    setError(null)
    try {
      await api.del(`/leave/holidays/${id}`)
      onDeleted?.(form.name)
    } catch (err) {
      setError(errorText(err, 'Could not remove that holiday'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="lv-form" onSubmit={submit}>
      {error && <div style={{ marginBottom: 12 }}><ErrorNote>{error}</ErrorNote></div>}
      <div className="settings-grid">
        <label className="setting">
          Date
          <input
            type="date"
            value={form.holiday_date}
            required
            onChange={(e) => setForm({ ...form, holiday_date: e.target.value })}
          />
        </label>
        <label className="setting">
          Name
          <input
            value={form.name}
            maxLength={160}
            required
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Republic Day"
          />
        </label>
        <label className="setting">
          Description <span className="setting-hint">Optional.</span>
          <input
            value={form.description}
            maxLength={2000}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </label>
      </div>

      <div className="filter-row" style={{ marginTop: 14, marginBottom: 0 }}>
        <label className="check-field">
          <input
            type="checkbox"
            checked={form.is_optional}
            onChange={(e) => setForm({ ...form, is_optional: e.target.checked })}
          />
          <span>Optional — employees opt in</span>
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
          />
          <span>Active</span>
        </label>
      </div>

      {form.is_optional && (
        <p className="setting-hint" style={{ marginTop: 8 }}>
          Only the employees who opt in are off; everyone else is expected at work and spends
          balance if they take it.
          {optInCount > 0 && <> {optInCount} {optInCount === 1 ? 'person has' : 'people have'} opted in so far.</>}
        </p>
      )}

      <div className="lv-actions" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy || !form.name.trim()}>
          {busy ? 'Saving…' : id ? 'Save holiday' : 'Add holiday'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {id && onDeleted && !confirmDelete && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(true)} disabled={busy}>
            Remove…
          </button>
        )}
        {id && onDeleted && confirmDelete && (
          <>
            <button type="button" className="btn btn-sm" onClick={remove} disabled={busy}>
              {busy ? 'Removing…' : 'Yes, remove it'}
            </button>
            <span className="setting-hint">
              Removing it deletes any opt-ins. Leave already applied for keeps its frozen
              duration; only future applications change. To stop it applying without losing the
              record, untick <b>Active</b> instead.
            </span>
          </>
        )}
      </div>
    </form>
  )
}
