/* Payroll settings — the cycle, PF, ESI, professional tax, LWF and exit settlement.

   The simulator on the right is the point of this screen. Statutory rules are the
   part of payroll people check against a printed circular, so the page runs the
   same function a pay run runs and shows what comes off at a wage you type —
   rather than letting somebody find out at month end.

   Rates are entered as percentages and stored as basis points. That conversion
   happens once, here, at the edge: 12% goes in as `1200` and never becomes a
   float on either side.

   Two rules the form explains rather than hides:

   * **The pension slice comes out of the employer's share**, so its rate cannot
     exceed the employer rate — the server refuses, and the hint says why.
   * **The PF ceiling is optional but the pension cap is separate**, because
     contributing on full wages while the pension slice stays capped is exactly
     how the scheme works and a single switch could not express it.

   One Save sends the whole configuration, cycle days and TDS included: the PUT
   replaces the row, so anything left out would fall back to its default. */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { money, toPaise } from '../../../lib/format'
import { ErrorNote, Loading } from '../../../components/ui'
import { IconBuilding, IconCalendar, IconCard, IconCheck, IconGauge, IconUsers } from '../../../components/Icons'
import type { PtSlab, StatutoryConfig, StatutoryPreview } from '../../../lib/types'
import '../../../styles/payroll.css'
import '../../../styles/statutory.css'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const STATES = [
  'Andhra Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Jharkhand', 'Karnataka',
  'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Meghalaya', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
  'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
]

/** Basis points in, percentage string out. */
function pctOf(bps: number): string {
  return String(bps / 100)
}

/** Percentage string in, basis points out. Null when it is not a number. */
function toBps(input: string): number | null {
  const value = Number(input.trim())
  if (!input.trim() || !Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100)
}

const DEFAULTS = {
  cycle_close_day: 31,
  salary_paid_day: 7,
  tds_enabled: true,
  pf_enabled: false,
  pf_employee_rate_bps: 1200,
  pf_employer_rate_bps: 1200,
  pf_pension_rate_bps: 833,
  pf_wage_ceiling: 1_500_000,
  pf_cap_at_ceiling: true,
  pf_pension_cap_at_ceiling: true,
  esi_enabled: false,
  esi_employee_rate_bps: 75,
  esi_employer_rate_bps: 325,
  esi_wage_threshold: 2_100_000,
  pt_enabled: false,
  pt_state: '',
  lwf_enabled: false,
  lwf_employee_amount: 0,
  lwf_employer_amount: 0,
  lwf_month: null as number | null,
  gratuity_enabled: false,
  gratuity_days_per_year: 15,
  gratuity_month_days: 26,
  gratuity_ceiling: 2_000_000_00,
  encashment_month_days: 26,
  encashment_on_basic: true,
}

type Draft = typeof DEFAULTS

export default function StatutorySettings({ embedded = false }: { embedded?: boolean } = {}) {
  const configQ = useQuery<StatutoryConfig | null>('statutory-config', () =>
    api.get<StatutoryConfig | null>('/statutory/config'),
  )
  const slabsQ = useQuery<PtSlab[]>('pt-slabs', () => api.get<PtSlab[]>('/statutory/slabs'))
  const [error, setError] = useState<string | null>(null)

  if (configQ.loading) return <Loading />
  if (configQ.error) return <ErrorNote>{configQ.error}</ErrorNote>

  return (
    <div className={`st ${embedded ? 'hs-org' : 'page'}`}>
      {!embedded && (
        <header className="page-head">
          <div>
            <h1>Statutory settings</h1>
            <p className="muted">
              What is deducted, and what the company contributes on top. Nothing is
              deducted until you switch it on.
            </p>
          </div>
        </header>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}
      {configQ.data === null && (
        <p className="pr-warn">
          Statutory deductions have never been configured for this company.
          Payslips currently show gross less loans only.
        </p>
      )}

      <div className="st-grid">
        <div className="st-main">
          <ConfigForm
            current={configQ.data ?? null}
            onSaved={() => { configQ.reload(); slabsQ.reload() }}
            onError={setError}
            slabs={(ptOn) => ptOn && (
              <Slabs
                slabs={slabsQ.data ?? []}
                onChanged={() => { slabsQ.reload(); configQ.reload() }}
                onError={setError}
              />
            )}
          />
        </div>
        <aside className="st-side">
          <Preview configured={configQ.data !== null} onError={setError} />
        </aside>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ pieces -- */

function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label}
            className={`hs-switch${on ? ' is-on' : ''}`} onClick={() => onChange(!on)}><span /></button>
  )
}

function Card({ icon, tone, title, sub, toggle, children }: {
  icon: ReactNode
  tone: 'teal' | 'green' | 'blue' | 'amber' | 'purple'
  title: string
  sub: string
  toggle?: { on: boolean; label: string; onChange: (on: boolean) => void }
  children?: ReactNode
}) {
  return (
    <section className="st-card">
      <header className="st-card-head">
        <i className={`st-ic is-${tone}`} aria-hidden>{icon}</i>
        <div><h2>{title}</h2><p>{sub}</p></div>
        {toggle && (
          <label className="st-tog"><span>{toggle.label}</span><Switch on={toggle.on} onChange={toggle.onChange} label={toggle.label} /></label>
        )}
      </header>
      {children && <div className="st-card-body">{children}</div>}
    </section>
  )
}

function Row({ title, hint, on, onChange }: { title: string; hint: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="st-row">
      <div><b>{title}</b><span>{hint}</span></div>
      <Switch on={on} onChange={onChange} label={title} />
    </div>
  )
}

function Field({ label, hint, bad, children }: { label: string; hint?: string; bad?: boolean; children: ReactNode }) {
  return (
    <label className={`st-f${bad ? ' is-bad' : ''}`}>
      <span className="st-fl">{label}</span>
      {children}
      {hint && <span className="st-hint">{hint}</span>}
    </label>
  )
}

function ConfigForm({
  current,
  onSaved,
  onError,
  slabs,
}: {
  current: StatutoryConfig | null
  onSaved: () => void
  onError: (message: string) => void
  /** The professional-tax slab table, drawn inside the professional-tax card once it is on. */
  slabs: (ptOn: boolean) => ReactNode
}) {
  const raw = current as unknown as Record<string, unknown> | null
  const [draft, setDraft] = useState<Draft>(() =>
    current
      ? {
          cycle_close_day: Number(raw?.cycle_close_day ?? 31),
          salary_paid_day: Number(raw?.salary_paid_day ?? 7),
          tds_enabled: Boolean(raw?.tds_enabled ?? true),
          pf_enabled: current.pf_enabled,
          pf_employee_rate_bps: current.pf_employee_rate_bps,
          pf_employer_rate_bps: current.pf_employer_rate_bps,
          pf_pension_rate_bps: current.pf_pension_rate_bps,
          pf_wage_ceiling: current.pf_wage_ceiling,
          pf_cap_at_ceiling: current.pf_cap_at_ceiling,
          pf_pension_cap_at_ceiling: current.pf_pension_cap_at_ceiling,
          esi_enabled: current.esi_enabled,
          esi_employee_rate_bps: current.esi_employee_rate_bps,
          esi_employer_rate_bps: current.esi_employer_rate_bps,
          esi_wage_threshold: current.esi_wage_threshold,
          pt_enabled: current.pt_enabled,
          pt_state: current.pt_state ?? '',
          lwf_enabled: current.lwf_enabled,
          lwf_employee_amount: current.lwf_employee_amount,
          lwf_employer_amount: current.lwf_employer_amount,
          lwf_month: current.lwf_month,
          gratuity_enabled: current.gratuity_enabled,
          gratuity_days_per_year: current.gratuity_days_per_year,
          gratuity_month_days: current.gratuity_month_days,
          gratuity_ceiling: current.gratuity_ceiling,
          encashment_month_days: current.encashment_month_days,
          encashment_on_basic: current.encashment_on_basic,
        }
      : { ...DEFAULTS },
  )
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setSaved(false)
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const pensionTooHigh = draft.pf_pension_rate_bps > draft.pf_employer_rate_bps
  const cycleBad = !(Number.isInteger(draft.cycle_close_day) && draft.cycle_close_day >= 1 && draft.cycle_close_day <= 31)
    || !(Number.isInteger(draft.salary_paid_day) && draft.salary_paid_day >= 1 && draft.salary_paid_day <= 28)

  async function save() {
    setBusy(true)
    try {
      await api.put('/statutory/config', {
        ...draft,
        pt_state: draft.pt_state.trim() || null,
      })
      setSaved(true)
      onSaved()
    } catch (caught) {
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const stateOptions = draft.pt_state && !STATES.includes(draft.pt_state) ? [draft.pt_state, ...STATES] : STATES

  return (
    <>
      <Card icon={<IconCalendar size={18} />} tone="teal" title="Payroll Cycle & Income Tax"
            sub="Monthly attendance cutoff, payout schedule, and TDS automation">
        <div className="st-two">
          <Field label="Cycle closes on day" hint="31 = last day of the month" bad={draft.cycle_close_day < 1 || draft.cycle_close_day > 31}>
            <span className="st-in"><input type="number" min={1} max={31} step={1} value={draft.cycle_close_day}
                                           onChange={(e) => set('cycle_close_day', Number(e.target.value))} /><em>Day</em></span>
          </Field>
          <Field label="Salary paid on day" hint="Of the following month" bad={draft.salary_paid_day < 1 || draft.salary_paid_day > 28}>
            <span className="st-in"><input type="number" min={1} max={28} step={1} value={draft.salary_paid_day}
                                           onChange={(e) => set('salary_paid_day', Number(e.target.value))} /><em>Day</em></span>
          </Field>
        </div>
        <Row title="TDS on salary" hint="Automatically deduct income tax as per each employee's tax regime declaration"
             on={draft.tds_enabled} onChange={(v) => set('tds_enabled', v)} />
      </Card>

      <Card icon={<IconUsers size={18} />} tone="green" title="Provident Fund (EPF & EPS)"
            sub="Employees' Provident Fund and pension contribution splits"
            toggle={{ on: draft.pf_enabled, label: 'Deduct provident fund', onChange: (v) => set('pf_enabled', v) }}>
        {draft.pf_enabled && (
          <>
            <div className="st-four">
              <Rate label="Employee %" bps={draft.pf_employee_rate_bps} onChange={(v) => set('pf_employee_rate_bps', v)} />
              <Rate label="Employer %" bps={draft.pf_employer_rate_bps} onChange={(v) => set('pf_employer_rate_bps', v)} />
              <Rate label="Of which pension %" bps={draft.pf_pension_rate_bps} bad={pensionTooHigh}
                    hint="The EPS slice, out of the employer share." onChange={(v) => set('pf_pension_rate_bps', v)} />
              <Amount label="Wage ceiling" paise={draft.pf_wage_ceiling} onChange={(v) => set('pf_wage_ceiling', v)} />
            </div>
            {pensionTooHigh && (
              <p className="pr-warn">The pension slice comes out of the employer share and cannot exceed it.</p>
            )}
            <div className="st-rows">
              <Row title="Cap contributions at the ceiling"
                   hint="Off means contributing on full wages, which is equally legitimate — and changes everybody's take-home."
                   on={draft.pf_cap_at_ceiling} onChange={(v) => set('pf_cap_at_ceiling', v)} />
              <Row title="Cap the pension slice at the ceiling"
                   hint="Separate switch: the pension slice stays capped even when EPF is not."
                   on={draft.pf_pension_cap_at_ceiling} onChange={(v) => set('pf_pension_cap_at_ceiling', v)} />
            </div>
          </>
        )}
      </Card>

      <Card icon={<IconCheck size={18} />} tone="blue" title="Employees' State Insurance (ESI)"
            sub="Medical and cash benefit contributions for eligible wage brackets"
            toggle={{ on: draft.esi_enabled, label: 'Deduct ESI', onChange: (v) => set('esi_enabled', v) }}>
        {draft.esi_enabled && (
          <div className="st-three">
            <Rate label="Employee %" bps={draft.esi_employee_rate_bps} onChange={(v) => set('esi_employee_rate_bps', v)} />
            <Rate label="Employer %" bps={draft.esi_employer_rate_bps} onChange={(v) => set('esi_employer_rate_bps', v)} />
            <Amount label="Applies below" paise={draft.esi_wage_threshold}
                    hint="Threshold, not a ceiling — at or above it ESI stops entirely."
                    onChange={(v) => set('esi_wage_threshold', v)} />
          </div>
        )}
      </Card>

      <Card icon={<IconBuilding size={18} />} tone="blue" title="Professional Tax (PT)"
            sub="State-level monthly gross salary slab deductions"
            toggle={{ on: draft.pt_enabled, label: 'Deduct professional tax', onChange: (v) => set('pt_enabled', v) }}>
        {draft.pt_enabled && (
          <>
            <Field label="State jurisdiction" hint="Add the bands below once this is on and saved.">
              <select className="st-select" value={draft.pt_state} onChange={(e) => set('pt_state', e.target.value)}>
                <option value="">Select a state</option>
                {stateOptions.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            {slabs(current?.pt_enabled ?? false)}
          </>
        )}
      </Card>

      <Card icon={<IconCard size={18} />} tone="amber" title="Labour Welfare Fund (LWF)"
            sub="Periodic statutory welfare contribution rules"
            toggle={{ on: draft.lwf_enabled, label: 'Deduct LWF', onChange: (v) => set('lwf_enabled', v) }}>
        {draft.lwf_enabled && (
          <div className="st-three">
            <Amount label="Employee" paise={draft.lwf_employee_amount} onChange={(v) => set('lwf_employee_amount', v)} />
            <Amount label="Employer" paise={draft.lwf_employer_amount} onChange={(v) => set('lwf_employer_amount', v)} />
            <Field label="Collection month" hint="Most states collect once or twice a year.">
              <select className="st-select" value={draft.lwf_month ?? ''}
                      onChange={(e) => set('lwf_month', e.target.value ? Number(e.target.value) : null)}>
                <option value="">Every month</option>
                {MONTHS.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}
              </select>
            </Field>
          </div>
        )}
      </Card>

      {/* Read only when somebody leaves — see `services/settlement`. Grouped here rather than on the
          exit screen so there is one place the company decides what a day of leave is worth. */}
      <Card icon={<IconGauge size={18} />} tone="purple" title="Exit & Full-and-Final Settlement"
            sub="Leave encashment divisor and statutory gratuity calculation rules">
        <p className="st-note">Nothing below affects a monthly payslip. It is read only when a full-and-final settlement is computed.</p>
        <div className="st-two">
          <Field label="Leave encashment: days in a month" hint="26 and 30 are both common, and they differ by 15%.">
            <input className="st-plain" type="number" min={1} max={31} value={draft.encashment_month_days}
                   onChange={(e) => set('encashment_month_days', Number(e.target.value))} />
          </Field>
          <Field label="Encash on" hint="Basic is the usual reading. Flagged in the pay component catalogue.">
            <select className="st-select" value={draft.encashment_on_basic ? 'basic' : 'gross'}
                    onChange={(e) => set('encashment_on_basic', e.target.value === 'basic')}>
              <option value="basic">Basic</option>
              <option value="gross">Gross</option>
            </select>
          </Field>
        </div>
        <div className="st-box">
          <div className="st-box-head">
            <div>
              <b>Compute gratuity</b>
              <span>Payment of Gratuity Act, 1972. Due after five years of continuous service; a part-year of six months or more counts as a full year.</span>
            </div>
            <Switch on={draft.gratuity_enabled} onChange={(v) => set('gratuity_enabled', v)} label="Compute gratuity" />
          </div>
          {draft.gratuity_enabled && (
            <div className="st-three st-box-body">
              <Field label="Days per completed year" hint="15 is the statutory figure.">
                <input className="st-plain" type="number" min={0} max={90} value={draft.gratuity_days_per_year}
                       onChange={(e) => set('gratuity_days_per_year', Number(e.target.value))} />
              </Field>
              <Field label="Divided by" hint="26 notional working days.">
                <input className="st-plain" type="number" min={1} max={31} value={draft.gratuity_month_days}
                       onChange={(e) => set('gratuity_month_days', Number(e.target.value))} />
              </Field>
              <Amount label="Ceiling" paise={draft.gratuity_ceiling} hint="Statutory limit: ₹20,00,000"
                      onChange={(v) => set('gratuity_ceiling', v)} />
            </div>
          )}
        </div>
      </Card>

      <div className="st-save">
        <button className="btn btn-primary" disabled={busy || pensionTooHigh || cycleBad} onClick={save}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
        {saved && <span className="ok-note">Saved</span>}
        <span className="muted">Applies to the next pay run computed. Runs already approved keep their own frozen figures.</span>
      </div>
    </>
  )
}

function Rate({
  label,
  bps,
  onChange,
  hint,
  bad,
}: {
  label: string
  bps: number
  onChange: (bps: number) => void
  hint?: string
  bad?: boolean
}) {
  const [text, setText] = useState(() => pctOf(bps))
  return (
    <Field label={label} hint={hint} bad={bad}>
      <span className="st-in"><input placeholder="12" value={text} type="number" data-spin min={0} step="any"
                                     onChange={(e) => {
                                       setText(e.target.value)
                                       const next = toBps(e.target.value)
                                       if (next !== null) onChange(next)
                                     }} /><em>%</em></span>
    </Field>
  )
}

function Amount({
  label,
  paise,
  onChange,
  hint,
}: {
  label: string
  paise: number
  onChange: (paise: number) => void
  hint?: string
}) {
  const [text, setText] = useState(() => String(paise / 100))
  return (
    <Field label={label} hint={hint}>
      <span className="st-in is-pre"><em>₹</em><input placeholder="15000" value={text} type="number" data-spin min={0} step="any"
                                                     onChange={(e) => {
                                                       setText(e.target.value)
                                                       const next = toPaise(e.target.value)
                                                       if (next !== null) onChange(next)
                                                     }} /></span>
    </Field>
  )
}

function Slabs({
  slabs,
  onChanged,
  onError,
}: {
  slabs: PtSlab[]
  onChanged: () => void
  onError: (message: string) => void
}) {
  const [min, setMin] = useState('')
  const [max, setMax] = useState('')
  const [amount, setAmount] = useState('')
  const [month, setMonth] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    try {
      await action()
      onChanged()
    } catch (caught) {
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const minPaise = toPaise(min)
  const amountPaise = toPaise(amount)
  const ready = minPaise !== null && amountPaise !== null

  return (
    <div className="st-slabs">
      <div className="st-slabs-head">
        <b>Professional tax slabs</b>
        <span>{slabs.length} {slabs.length === 1 ? 'band' : 'bands'}</span>
      </div>
      {!slabs.length && (
        <p className="pr-warn">
          Professional tax is switched on with no slabs configured, so nothing is
          being deducted. Add the bands for your state.
        </p>
      )}

      <div className="st-add">
        <Field label="From (₹)"><input className="st-plain" value={min} type="number" data-spin min={0} step="any" placeholder="0"
                                       onChange={(e) => setMin(e.target.value)} /></Field>
        <Field label="To (₹)"><input className="st-plain" value={max} type="number" data-spin min={0} step="any" placeholder="blank = no limit"
                                     onChange={(e) => setMax(e.target.value)} /></Field>
        <Field label="Deduct (₹)"><input className="st-plain" value={amount} type="number" data-spin min={0} step="any" placeholder="200"
                                         onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Month">
          <select className="st-select" value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="">Every month</option>
            {MONTHS.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}
          </select>
        </Field>
        <button type="button" className="btn btn-primary st-addbtn" disabled={!ready || busy}
                onClick={() => run(async () => {
                  await api.post('/statutory/slabs', {
                    min_gross: minPaise,
                    max_gross: max.trim() ? toPaise(max) : null,
                    amount: amountPaise,
                    applies_in_month: month ? Number(month) : null,
                  })
                  setMin(''); setMax(''); setAmount(''); setMonth('')
                })}>
          + Add band
        </button>
      </div>

      {slabs.length > 0 && (
        <>
          <table className="st-table">
            <thead>
              <tr><th>Salary band</th><th>Month</th><th>Deduct</th><th className="r">Action</th></tr>
            </thead>
            <tbody>
              {slabs.map((slab) => (
                <tr key={slab.id}>
                  <td>
                    {money(slab.min_gross)} — {slab.max_gross === null ? 'No limit' : money(slab.max_gross)}
                    {slab.label && <div className="muted-sm">{slab.label}</div>}
                  </td>
                  <td>{slab.applies_in_month ? MONTHS[slab.applies_in_month - 1] : 'Every month'}</td>
                  <td><b>{money(slab.amount)}</b></td>
                  <td className="r">
                    <button type="button" className="st-remove" disabled={busy}
                            onClick={() => run(() => api.del(`/statutory/slabs/${slab.id}`))}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="st-note">
            A month-specific band wins over a general one covering the same range — which is how a state that
            charges differently in one month is expressed.
          </p>
        </>
      )}
    </div>
  )
}

function Preview({
  configured,
  onError,
}: {
  configured: boolean
  onError: (message: string) => void
}) {
  const [pfWage, setPfWage] = useState('20000')
  const [esiWage, setEsiWage] = useState('50000')
  const [gross, setGross] = useState('50000')
  const [month, setMonth] = useState('1')
  const [result, setResult] = useState<StatutoryPreview | null>(null)
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    setBusy(true)
    try {
      setResult(await api.post<StatutoryPreview>('/statutory/preview', {
        pf_wage: toPaise(pfWage) ?? 0,
        esi_wage: toPaise(esiWage) ?? 0,
        gross: toPaise(gross) ?? 0,
        month: Number(month) || 1,
      }))
    } catch (caught) {
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }, [pfWage, esiWage, gross, month, onError])

  // Live: recompute a moment after the figures change, once there is a saved configuration to run.
  useEffect(() => {
    if (!configured) return
    const t = setTimeout(() => { void run() }, 450)
    return () => clearTimeout(t)
  }, [configured, run])

  const takeHome = result ? (toPaise(gross) ?? 0) - result.employee_total : null

  return (
    <section className="st-sim">
      <header className="st-sim-head">
        <div className="st-sim-top">
          <h2><i aria-hidden><IconGauge size={16} /></i> What would come off</h2>
          <span className="st-live">Live simulator</span>
        </div>
        <p>Runs the same computation a pay run runs. Check it against your circular right here.</p>
      </header>

      <div className="st-sim-body">
        {!configured && <p className="st-note">Save the settings first, then the simulator runs.</p>}
        <div className="st-sim-grid">
          <Field label="PF wages" hint="Usually basic wages">
            <span className="st-in is-pre"><em>₹</em><input value={pfWage} type="number" data-spin min={0} step="any" onChange={(e) => setPfWage(e.target.value)} /></span>
          </Field>
          <Field label="ESI wages" hint="ESI gross components">
            <span className="st-in is-pre"><em>₹</em><input value={esiWage} type="number" data-spin min={0} step="any" onChange={(e) => setEsiWage(e.target.value)} /></span>
          </Field>
          <Field label="Salary gross" hint="For PT band (excl. reimb.)">
            <span className="st-in is-pre"><em>₹</em><input value={gross} type="number" data-spin min={0} step="any" onChange={(e) => setGross(e.target.value)} /></span>
          </Field>
          <Field label="Month" hint="Tests PT & LWF month">
            <select className="st-select" value={month} onChange={(e) => setMonth(e.target.value)}>
              {MONTHS.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}
            </select>
          </Field>
        </div>
        <button type="button" className="st-compute" disabled={busy || !configured} onClick={run}>
          {busy ? 'Computing…' : '▷ Compute now'}
        </button>
      </div>

      {result && (
        <div className="st-result">
          <div className="st-group">
            <div className="st-group-head"><span>Employee deductions</span><em>From gross</em></div>
            {result.employee_lines.length ? result.employee_lines.map((line) => (
              <div key={line.code} className="st-line">
                <div><b>{line.name || line.code}</b><span>{line.detail ?? ''}</span></div>
                <strong>{money(line.amount)}</strong>
              </div>
            )) : <p className="st-note">Nothing is deducted.</p>}
            <div className="st-total"><span>Total employee deductions</span><b className="is-neg">− {money(result.employee_total)}</b></div>
          </div>
          <div className="st-group">
            <div className="st-group-head"><span>Employer contributions</span><em>CTC component</em></div>
            {result.employer_lines.length ? result.employer_lines.map((line) => (
              <div key={line.code} className="st-line">
                <div><b>{line.name || line.code}</b><span>{line.detail ?? ''}</span></div>
                <strong>{money(line.amount)}</strong>
              </div>
            )) : <p className="st-note">Nothing on top.</p>}
            <div className="st-total"><span>Total employer cost</span><b>{money(result.employer_total)}</b></div>
          </div>
          {takeHome !== null && (
            <div className="st-take">
              <div><small>Estimated net take-home</small><span>Before income tax (TDS)</span></div>
              <b>{money(takeHome)}</b>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
