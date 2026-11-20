/* HR Settings → Payroll: Payroll setup, and Sales Target.
 *
 * Payroll setup is the cycle (when it closes, when salary is paid) and the statutory deductions.
 * The statutory numbers are the same ones the full statutory page holds (/settings/payroll…);
 * this shows the ones people reach for. Sales Target is the incentive rule, plus a monthly
 * table where HR assigns each person a target and raises the incentives that have been earned.
 */

import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { canAdminister, useAuth } from '../../../lib/auth'
import { EmptyState, ErrorNote, Loading } from '../../../components/ui'
import { IconCard, IconStar } from '../../../components/Icons'

type Sub = 'setup' | 'sales'

export default function PayrollTab() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const sub: Sub = params.get('sub') === 'sales' ? 'sales' : 'setup'
  const go = (next: Sub) => {
    const keep: Record<string, string> = {}
    params.forEach((value, key) => { keep[key] = value })
    setParams({ ...keep, sub: next }, { replace: true })
  }
  const tabs: Array<{ key: Sub; label: string; icon: ReactNode }> = [
    { key: 'setup', label: 'Payroll setup', icon: <IconCard size={15} /> },
    { key: 'sales', label: 'Sales Target', icon: <IconStar size={15} /> },
  ]
  if (!canAdminister(user)) {
    return <EmptyState title="Payroll settings are for administrators" body="The payroll cycle, statutory deductions and incentive rules are set by an owner or administrator." />
  }
  return (
    <div className="hs-org">
      <nav className="hs-tabs hs-subtabs" role="tablist" aria-label="Payroll settings">
        {tabs.map((t) => (
          <button key={t.key} role="tab" type="button" aria-selected={sub === t.key}
                  className={`hs-tab${sub === t.key ? ' is-on' : ''}`} onClick={() => go(t.key)}>
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>
      {sub === 'setup' ? <PayrollSetup /> : <SalesTarget />}
    </div>
  )
}

/* ------------------------------------------------------------ payroll setup -- */

type Config = Record<string, unknown> & {
  cycle_close_day: number; salary_paid_day: number; tds_enabled: boolean
  pf_enabled: boolean; pf_employee_rate_bps: number; pf_employer_rate_bps: number; pf_wage_ceiling: number
  esi_enabled: boolean; esi_employee_rate_bps: number; esi_employer_rate_bps: number; esi_wage_threshold: number
  pt_enabled: boolean
}

/** What a company has before it has saved anything: the cycle at month end, paid on the 7th, and
 *  the statutory defaults the server holds. Only the fields this screen shows are listed; the rest
 *  of a saved configuration is carried through unchanged when it is sent back. */
const DEFAULTS: Config = {
  cycle_close_day: 31, salary_paid_day: 7, tds_enabled: true,
  pf_enabled: false, pf_employee_rate_bps: 1200, pf_employer_rate_bps: 1200, pf_wage_ceiling: 1_500_000,
  esi_enabled: false, esi_employee_rate_bps: 75, esi_employer_rate_bps: 325, esi_wage_threshold: 2_100_000,
  pt_enabled: false,
}

const rupees = (paise: number) => String(paise / 100)
const percent = (bps: number) => String(bps / 100)

function PayrollSetup() {
  const q = useQuery<Config | null>('hr-statutory-config', () => api.get<Config | null>('/statutory/config'))
  const [draft, setDraft] = useState<Record<string, string | boolean> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  if (q.error) return <ErrorNote>{q.error}</ErrorNote>
  if (q.loading && q.data === undefined) return <Loading />

  const stored: Config = { ...DEFAULTS, ...(q.data ?? {}) }
  const initial = {
    cycle: String(stored.cycle_close_day), paid: String(stored.salary_paid_day), tds: stored.tds_enabled,
    pf: stored.pf_enabled, pfEmp: percent(stored.pf_employee_rate_bps), pfEr: percent(stored.pf_employer_rate_bps), pfCeil: rupees(stored.pf_wage_ceiling),
    esi: stored.esi_enabled, esiEmp: percent(stored.esi_employee_rate_bps), esiEr: percent(stored.esi_employer_rate_bps), esiCeil: rupees(stored.esi_wage_threshold),
    pt: stored.pt_enabled,
  }
  const form = { ...initial, ...(draft ?? {}) } as typeof initial
  const dirty = draft !== null && JSON.stringify(form) !== JSON.stringify(initial)
  const set = (patch: Partial<typeof initial>) => { setSaved(false); setDraft({ ...(draft ?? {}), ...patch }) }

  const whole = (v: string, lo: number, hi: number) => v.trim() !== '' && Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi
  const dec = (v: string, hi: number) => v.trim() !== '' && Number(v) >= 0 && Number(v) <= hi
  const bad = {
    cycle: !whole(form.cycle, 1, 31), paid: !whole(form.paid, 1, 28),
    pfEmp: !dec(form.pfEmp, 100), pfEr: !dec(form.pfEr, 100), pfCeil: !dec(form.pfCeil, 1_000_000),
    esiEmp: !dec(form.esiEmp, 100), esiEr: !dec(form.esiEr, 100), esiCeil: !dec(form.esiCeil, 10_000_000),
  }
  const invalid = Object.values(bad).some(Boolean)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      // The saved configuration goes back whole, with only what this screen changes replaced:
      // the PUT replaces the row, so anything left out would fall back to its default.
      const { id: _id, org_id: _org, pt_slab_count: _slabs, ...kept } = (q.data ?? {}) as Record<string, unknown>
      void _id; void _org; void _slabs
      await api.put('/statutory/config', {
        ...kept,
        cycle_close_day: Number(form.cycle), salary_paid_day: Number(form.paid), tds_enabled: form.tds,
        pf_enabled: form.pf, pf_employee_rate_bps: Math.round(Number(form.pfEmp) * 100), pf_employer_rate_bps: Math.round(Number(form.pfEr) * 100),
        pf_wage_ceiling: Math.round(Number(form.pfCeil) * 100),
        esi_enabled: form.esi, esi_employee_rate_bps: Math.round(Number(form.esiEmp) * 100), esi_employer_rate_bps: Math.round(Number(form.esiEr) * 100),
        esi_wage_threshold: Math.round(Number(form.esiCeil) * 100),
        pt_enabled: form.pt,
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
    <>
      <section className="card hs-card">
        <header className="hs-card-head lp-head"><h2>Payroll cycle</h2><span className="lp-note">Saved now, used by Payroll</span></header>
        <div className="hs-card-body">
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="lp-grid">
            <label className="hs-field">
              <span className="hs-label">Cycle closes on day</span>
              <input type="number" data-spin min={1} max={31} step={1} value={form.cycle} className={bad.cycle ? 'is-bad' : ''} onChange={(e) => set({ cycle: e.target.value })} />
              <span className="hs-hint">31 = last day of the month</span>
            </label>
            <label className="hs-field">
              <span className="hs-label">Salary paid on day</span>
              <input type="number" data-spin min={1} max={28} step={1} value={form.paid} className={bad.paid ? 'is-bad' : ''} onChange={(e) => set({ paid: e.target.value })} />
              <span className="hs-hint">Of the following month</span>
            </label>
          </div>
        </div>
      </section>

      <section className="card hs-card" style={{ marginTop: 14 }}>
        <header className="hs-card-head lp-head"><h2>Statutory deductions</h2><span className="lp-note">Saved now, used by Payroll</span></header>
        <div className="hs-card-body">
          <label className="crm-check pr-check"><input type="checkbox" checked={form.pf} onChange={(e) => set({ pf: e.target.checked })} /> Provident Fund (PF)</label>
          {form.pf && (
            <div className="pr-fields">
              <label className="hs-field"><span className="hs-label">Employee %</span>
                <input type="number" data-spin min={0} step="any" value={form.pfEmp} className={bad.pfEmp ? 'is-bad' : ''} onChange={(e) => set({ pfEmp: e.target.value })} /></label>
              <label className="hs-field"><span className="hs-label">Employer %</span>
                <input type="number" data-spin min={0} step="any" value={form.pfEr} className={bad.pfEr ? 'is-bad' : ''} onChange={(e) => set({ pfEr: e.target.value })} /></label>
              <label className="hs-field"><span className="hs-label">Wage ceiling (₹)</span>
                <input type="number" data-spin min={0} step="any" value={form.pfCeil} className={bad.pfCeil ? 'is-bad' : ''} onChange={(e) => set({ pfCeil: e.target.value })} /></label>
            </div>
          )}

          <label className="crm-check pr-check"><input type="checkbox" checked={form.esi} onChange={(e) => set({ esi: e.target.checked })} /> Employees’ State Insurance (ESIC)</label>
          {form.esi && (
            <div className="pr-fields">
              <label className="hs-field"><span className="hs-label">Employee %</span>
                <input type="number" data-spin min={0} step="any" value={form.esiEmp} className={bad.esiEmp ? 'is-bad' : ''} onChange={(e) => set({ esiEmp: e.target.value })} /></label>
              <label className="hs-field"><span className="hs-label">Employer %</span>
                <input type="number" data-spin min={0} step="any" value={form.esiEr} className={bad.esiEr ? 'is-bad' : ''} onChange={(e) => set({ esiEr: e.target.value })} /></label>
              <label className="hs-field"><span className="hs-label">Gross ceiling (₹)</span>
                <input type="number" data-spin min={0} step="any" value={form.esiCeil} className={bad.esiCeil ? 'is-bad' : ''} onChange={(e) => set({ esiCeil: e.target.value })} />
                <span className="hs-hint">Above this ESIC does not apply</span></label>
            </div>
          )}

          <label className="crm-check pr-check"><input type="checkbox" checked={form.pt} onChange={(e) => set({ pt: e.target.checked })} /> Professional Tax</label>
          <label className="crm-check pr-check"><input type="checkbox" checked={form.tds} onChange={(e) => set({ tds: e.target.checked })} /> TDS on salary</label>
        </div>
        <div className="hs-actions">
          {saved && !dirty && <span className="hs-saved">Saved</span>}
          <button className="btn" disabled={!dirty || busy} onClick={() => { setDraft(null); setSaved(false) }}>Discard</button>
          <button className="btn btn-primary" disabled={!dirty || busy || invalid} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</button>
        </div>
      </section>
    </>
  )
}

/* -------------------------------------------------------------- sales target -- */

interface Rule {
  is_enabled: boolean; target_type: string; default_target: number
  incentive_type: string; incentive_paise: number; achievement: string; min_percent: number; requires_approval: boolean
}
interface TargetRow { user_id: string; name: string; target: number; is_set: boolean; achieved: number; earned: number }

const inr = (n: number) => Math.round(n).toLocaleString('en-IN')

function SalesTarget() {
  const q = useQuery<Rule>('incentive-rule', () => api.get<Rule>('/incentives/rule'))
  const [draft, setDraft] = useState<{ on: boolean; ttype: string; target: string; itype: string; amount: string; achievement: string; minPct: string; approval: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  if (q.error) return <ErrorNote>{q.error}</ErrorNote>
  if (!q.data) return <Loading />

  const r = q.data
  const initial = { on: r.is_enabled, ttype: r.target_type, target: String(r.default_target), itype: r.incentive_type, amount: String(r.incentive_paise / 100), achievement: r.achievement, minPct: String(r.min_percent), approval: r.requires_approval }
  const form = draft ?? initial
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(initial)
  const set = (patch: Partial<typeof initial>) => { setSaved(false); setDraft({ ...form, ...patch }) }
  const targetBad = !(form.target.trim() !== '' && Number.isInteger(Number(form.target)) && Number(form.target) >= 0)
  const amountBad = !(form.amount.trim() !== '' && Number(form.amount) >= 0 && (form.itype !== 'percent' || Number(form.amount) <= 100))
  const minBad = form.achievement === 'min' && !(Number.isInteger(Number(form.minPct)) && Number(form.minPct) >= 1 && Number(form.minPct) <= 100)
  const sales = form.ttype === 'sales'
  const pct = form.itype === 'percent'

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await api.put('/incentives/rule', {
        is_enabled: form.on, target_type: form.ttype, default_target: Number(form.target),
        incentive_type: form.itype, incentive_paise: Math.round(Number(form.amount) * 100),
        achievement: form.achievement, min_percent: Number(form.minPct) || 80, requires_approval: form.approval,
      })
      setDraft(null)
      setSaved(true)
      q.reload()
    } catch (err) {
      setError((err as { message?: string }).message ?? 'That could not be saved')
    } finally {
      setBusy(false)
    }
  }

  const amount = Number(form.amount) || 0
  const target = Number(form.target) || 0
  const unit = sales ? `Rs. ${inr(target)} of sales` : `${target} customers`
  const cond = form.achievement === 'full' ? 'on reaching 100%' : form.achievement === 'min' ? `from ${form.minPct || 0}% of the target` : 'in proportion to achievement'
  const what = pct ? `${amount}% of the sales made` : `Rs. ${inr(amount)}`
  const rule = `${unit} → ${what} ${cond}.`
  const approver = form.approval ? ', once the RM/HOD approves it' : ''
  const sample = sales ? Math.round(target * 1.1) : Math.max(1, Math.round(target * 1.1))
  const example = pct
    ? `Sales of Rs. ${inr(sample)} earn ${amount}% = Rs. ${inr(sample * amount / 100)}${approver}${form.achievement === 'full' ? ', as the target is met' : ''}. Assigning a target on its own earns nothing.`
    : form.achievement === 'prorata'
      ? `Reaching half the target earns Rs. ${inr(amount / 2)}${approver}. Assigning a target on its own earns nothing.`
      : `Meeting the condition earns Rs. ${inr(amount)}${approver}. Assigning a target on its own earns nothing.`

  return (
    <>
      <section className="card hs-card">
        <header className="hs-card-head lp-head"><h2>Sales target and incentive</h2><span className="lp-note">Saved now, used by Approvals and Payroll</span></header>
        <div className="hs-card-body hs-ot">
          {error && <ErrorNote>{error}</ErrorNote>}
          <label className="hs-ot-box">
            <input type="checkbox" checked={form.on} onChange={(e) => set({ on: e.target.checked })} />
            <span>
              <b>Sales targets and incentives</b>
              <span className="muted-sm">HR assigns a target per employee per month. Achieving it raises an incentive for approval; approving it puts the amount on that month’s payslip.</span>
            </span>
          </label>
          {form.on && (
            <>
              <div className="hs-ot-grid hs-ot-2">
                <label className="setting">Target type
                  <select value={form.ttype} onChange={(e) => set({ ttype: e.target.value, itype: e.target.value === 'sales' ? form.itype : 'fixed' })}>
                    <option value="customers">Number of customers</option>
                    <option value="sales">Sales amount</option>
                  </select>
                </label>
                <label className="setting">{sales ? 'Target amount (Rs.)' : 'Target — number of customers'}
                  <input type="number" data-spin min={0} step={1} value={form.target} className={targetBad ? 'is-bad' : ''} onChange={(e) => set({ target: e.target.value })} />
                </label>
                <label className="setting">Incentive type
                  <select value={form.itype} onChange={(e) => set({ itype: e.target.value })}>
                    <option value="fixed">Fixed amount</option>
                    {sales && <option value="percent">Percentage of sales</option>}
                  </select>
                </label>
                <label className="setting">{pct ? 'Incentive (% of sales)' : 'Incentive (Rs.)'}
                  <input type="number" data-spin min={0} max={pct ? 100 : undefined} step="any" value={form.amount} className={amountBad ? 'is-bad' : ''} onChange={(e) => set({ amount: e.target.value })} />
                </label>
              </div>
              <label className="setting">Achievement condition
                <select value={form.achievement} onChange={(e) => set({ achievement: e.target.value })}>
                  <option value="full">Only at 100%</option>
                  <option value="min">At or above a minimum</option>
                  <option value="prorata">Proportional</option>
                </select>
                <span className="muted-sm">{form.achievement === 'full' ? 'Nothing is earned below the target. The usual arrangement.' : form.achievement === 'min' ? 'Earned in full once the minimum is reached, nothing below it.' : pct ? 'A share of whatever sales are made, with no threshold.' : 'Earned in proportion to what was achieved, up to the full amount.'}</span>
              </label>
              {form.achievement === 'min' && (
                <label className="setting">Minimum achievement (%)
                  <input type="number" data-spin min={1} max={100} step={1} value={form.minPct} className={minBad ? 'is-bad' : ''} onChange={(e) => set({ minPct: e.target.value })} />
                </label>
              )}
              <label className="hs-ot-box">
                <input type="checkbox" checked={form.approval} onChange={(e) => set({ approval: e.target.checked })} />
                <span>
                  <b>An achieved target needs RM/HOD approval</b>
                  <span className="muted-sm">It goes to the Approvals queue and follows the hierarchy set in the Approval Master. Off pays an achieved target straight into payroll with nobody asked.</span>
                </span>
              </label>
              <div className="hs-ot-rule">
                <span className="hs-ot-rule-title">The rule, in words</span>
                <p>{rule}</p>
                <p><b>Worked example.</b> {example}</p>
              </div>
            </>
          )}
        </div>
        <div className="hs-actions">
          {saved && !dirty && <span className="hs-saved">Saved</span>}
          <button className="btn" disabled={!dirty || busy} onClick={() => { setDraft(null); setSaved(false) }}>Discard</button>
          <button className="btn btn-primary" disabled={!dirty || busy || (form.on && (targetBad || amountBad || minBad))} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</button>
        </div>
      </section>

      {r.is_enabled && <MonthlyTargets sales={r.target_type === 'sales'} />}
    </>
  )
}

function MonthlyTargets({ sales }: { sales: boolean }) {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const q = useQuery<TargetRow[]>(`incentive-targets-${year}-${month}`, () => api.get<TargetRow[]>(`/incentives/targets?year=${year}&month=${month}`))
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

  async function saveTargets() {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await api.put('/incentives/targets', {
        year, month,
        targets: Object.entries(edits).map(([user_id, value]) => ({ user_id, target: value.trim() === '' ? null : Number(value) })),
      })
      setEdits({})
      setMessage('Targets saved.')
      q.reload()
    } catch (err) {
      setError((err as { message?: string }).message ?? 'Those targets could not be saved')
    } finally {
      setBusy(false)
    }
  }

  async function raise() {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const rows = await api.post<Array<{ status: string }>>('/incentives/evaluate', { year, month })
      setMessage(rows.length === 0 ? 'Nobody has earned an incentive for this month yet.'
        : `${rows.length} incentive${rows.length === 1 ? '' : 's'} raised. Those needing approval are in the Approvals queue.`)
      q.reload()
    } catch (err) {
      setError((err as { message?: string }).message ?? 'The incentives could not be raised')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card hs-card" style={{ marginTop: 14 }}>
      <header className="hs-card-head lp-head">
        <h2>Targets and achievement</h2>
        <span className="pr-month">
          <select value={month} onChange={(e) => { setMonth(Number(e.target.value)); setEdits({}) }} aria-label="Month">
            {months.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
          <input type="number" data-spin min={2000} max={2100} step={1} value={year} onChange={(e) => { setYear(Number(e.target.value) || year); setEdits({}) }} aria-label="Year" />
        </span>
      </header>
      <div className="hs-card-body">
        {error && <ErrorNote>{error}</ErrorNote>}
        {message && <div className="notice notice-ok" style={{ marginBottom: 12 }}>{message}</div>}
        {q.loading && !q.data ? <Loading /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Employee</th><th>Target</th><th className="num">Achieved</th><th className="num">Earned</th></tr></thead>
              <tbody>
                {(q.data ?? []).map((row) => (
                  <tr key={row.user_id}>
                    <td><b>{row.name}</b></td>
                    <td>
                      <input type="number" data-spin min={0} step={1} className="pr-target"
                             value={edits[row.user_id] ?? (row.is_set ? String(row.target) : '')}
                             placeholder={`${sales ? inr(row.target) : row.target} (default)`}
                             onChange={(e) => setEdits({ ...edits, [row.user_id]: e.target.value })} />
                    </td>
                    <td className="num">{sales ? `₹${inr(row.achieved)}` : row.achieved}</td>
                    <td className="num">{row.earned ? `₹${inr(row.earned / 100)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="hs-actions">
        <button className="btn" disabled={busy || Object.keys(edits).length === 0} onClick={() => void saveTargets()}>Save targets</button>
        <button className="btn btn-primary" disabled={busy || Object.keys(edits).length > 0} onClick={() => void raise()} title="Raise an incentive for everyone who has earned one this month">Raise incentives</button>
      </div>
    </section>
  )
}
