/* Statutory settings — PF, ESI, professional tax, LWF.

   The preview at the bottom is the point of this screen. Statutory rules are the
   part of payroll people check against a printed circular, so the form runs the
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
     how the scheme works and a single switch could not express it. */

import { useCallback, useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { money, toPaise } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type { PtSlab, StatutoryConfig, StatutoryPreview } from '../../../lib/types'
import '../../../styles/payroll.css'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
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

export default function StatutorySettings() {
  const configQ = useQuery<StatutoryConfig | null>('statutory-config', () =>
    api.get<StatutoryConfig | null>('/statutory/config'),
  )
  const slabsQ = useQuery<PtSlab[]>('pt-slabs', () => api.get<PtSlab[]>('/statutory/slabs'))
  const [error, setError] = useState<string | null>(null)

  if (configQ.loading) return <Loading />
  if (configQ.error) return <ErrorNote>{configQ.error}</ErrorNote>

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Statutory settings</h1>
          <p className="muted">
            What is deducted, and what the company contributes on top. Nothing is
            deducted until you switch it on.
          </p>
        </div>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}
      {configQ.data === null && (
        <p className="pr-warn">
          Statutory deductions have never been configured for this company.
          Payslips currently show gross less loans only.
        </p>
      )}

      <ConfigForm
        current={configQ.data ?? null}
        onSaved={() => { configQ.reload(); slabsQ.reload() }}
        onError={setError}
      />

      {(configQ.data?.pt_enabled ?? false) && (
        <Slabs
          slabs={slabsQ.data ?? []}
          state={configQ.data?.pt_state ?? null}
          onChanged={() => { slabsQ.reload(); configQ.reload() }}
          onError={setError}
        />
      )}

      <Preview configured={configQ.data !== null} onError={setError} />
    </div>
  )
}

function ConfigForm({
  current,
  onSaved,
  onError,
}: {
  current: StatutoryConfig | null
  onSaved: () => void
  onError: (message: string) => void
}) {
  const [draft, setDraft] = useState<Draft>(() =>
    current
      ? {
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

  return (
    <section className="card pr-form">
      <h2 className="card-title">Provident Fund</h2>
      <label className="pr-check">
        <input type="checkbox" checked={draft.pf_enabled}
               onChange={(e) => set('pf_enabled', e.target.checked)} />
        <span>Deduct provident fund</span>
      </label>
      {draft.pf_enabled && (
        <>
          <div className="pr-row">
            <Rate label="Employee %" bps={draft.pf_employee_rate_bps}
                  onChange={(v) => set('pf_employee_rate_bps', v)} />
            <Rate label="Employer %" bps={draft.pf_employer_rate_bps}
                  onChange={(v) => set('pf_employer_rate_bps', v)} />
            <Rate label="of which pension %" bps={draft.pf_pension_rate_bps}
                  bad={pensionTooHigh}
                  hint="The EPS slice, out of the employer share."
                  onChange={(v) => set('pf_pension_rate_bps', v)} />
            <Amount label="Wage ceiling" paise={draft.pf_wage_ceiling}
                    onChange={(v) => set('pf_wage_ceiling', v)} />
          </div>
          {pensionTooHigh && (
            <p className="pr-warn">
              The pension slice comes out of the employer share and cannot exceed
              it.
            </p>
          )}
          <label className="pr-check">
            <input type="checkbox" checked={draft.pf_cap_at_ceiling}
                   onChange={(e) => set('pf_cap_at_ceiling', e.target.checked)} />
            <span>
              Cap contributions at the ceiling
              <span className="pr-field-hint">
                Off means contributing on full wages, which is equally
                legitimate — and changes everybody’s take-home.
              </span>
            </span>
          </label>
          <label className="pr-check">
            <input type="checkbox" checked={draft.pf_pension_cap_at_ceiling}
                   onChange={(e) => set('pf_pension_cap_at_ceiling', e.target.checked)} />
            <span>
              Cap the pension slice at the ceiling
              <span className="pr-field-hint">
                Separate switch: the pension slice stays capped even when EPF is
                not.
              </span>
            </span>
          </label>
        </>
      )}

      <h2 className="card-title">Employees’ State Insurance</h2>
      <label className="pr-check">
        <input type="checkbox" checked={draft.esi_enabled}
               onChange={(e) => set('esi_enabled', e.target.checked)} />
        <span>Deduct ESI</span>
      </label>
      {draft.esi_enabled && (
        <div className="pr-row">
          <Rate label="Employee %" bps={draft.esi_employee_rate_bps}
                onChange={(v) => set('esi_employee_rate_bps', v)} />
          <Rate label="Employer %" bps={draft.esi_employer_rate_bps}
                onChange={(v) => set('esi_employer_rate_bps', v)} />
          <Amount label="Applies below" paise={draft.esi_wage_threshold}
                  hint="A threshold, not a ceiling — at or above it ESI stops entirely."
                  onChange={(v) => set('esi_wage_threshold', v)} />
        </div>
      )}

      <h2 className="card-title">Professional tax</h2>
      <label className="pr-check">
        <input type="checkbox" checked={draft.pt_enabled}
               onChange={(e) => set('pt_enabled', e.target.checked)} />
        <span>
          Deduct professional tax
          <span className="pr-field-hint">
            A state slab table. Add the bands below once this is on and saved.
          </span>
        </span>
      </label>
      {draft.pt_enabled && (
        <div className="pr-row">
          <label className="pr-field">
            <span className="pr-field-label">State</span>
            <input value={draft.pt_state} placeholder="Karnataka"
                   onChange={(e) => set('pt_state', e.target.value)} />
          </label>
        </div>
      )}

      <h2 className="card-title">Labour Welfare Fund</h2>
      <label className="pr-check">
        <input type="checkbox" checked={draft.lwf_enabled}
               onChange={(e) => set('lwf_enabled', e.target.checked)} />
        <span>Deduct LWF</span>
      </label>
      {draft.lwf_enabled && (
        <div className="pr-row">
          <Amount label="Employee" paise={draft.lwf_employee_amount}
                  onChange={(v) => set('lwf_employee_amount', v)} />
          <Amount label="Employer" paise={draft.lwf_employer_amount}
                  onChange={(v) => set('lwf_employer_amount', v)} />
          <label className="pr-field">
            <span className="pr-field-label">Month</span>
            <select value={draft.lwf_month ?? ''}
                    onChange={(e) =>
                      set('lwf_month', e.target.value ? Number(e.target.value) : null)}>
              <option value="">Every month</option>
              {MONTHS.map((name, index) => (
                <option key={name} value={index + 1}>{name}</option>
              ))}
            </select>
            <span className="pr-field-hint">
              Most states collect once or twice a year.
            </span>
          </label>
        </div>
      )}

      {/* Read only when somebody leaves — see `services/settlement`. Grouped
          here rather than on the exit screen so there is one place the company
          decides what a day of leave is worth. */}
      <h2 className="card-title">Exit settlement</h2>
      <p className="muted">
        Nothing below affects a monthly payslip. It is read when a full-and-final
        settlement is computed.
      </p>

      <div className="pr-row">
        <label className="pr-field">
          <span className="pr-field-label">Leave encashment: days in a month</span>
          <input type="number" min={1} max={31} value={draft.encashment_month_days}
                 onChange={(e) => set('encashment_month_days', Number(e.target.value))} />
          <span className="pr-field-hint">
            26 and 30 are both common, and they differ by 15%.
          </span>
        </label>
        <label className="pr-field">
          <span className="pr-field-label">Encash on</span>
          <select value={draft.encashment_on_basic ? 'basic' : 'gross'}
                  onChange={(e) => set('encashment_on_basic', e.target.value === 'basic')}>
            <option value="basic">Basic</option>
            <option value="gross">Gross</option>
          </select>
          <span className="pr-field-hint">
            Basic is the usual reading. Which component is basic is whichever one
            you flagged in the pay component catalogue.
          </span>
        </label>
      </div>

      <label className="pr-check">
        <input type="checkbox" checked={draft.gratuity_enabled}
               onChange={(e) => set('gratuity_enabled', e.target.checked)} />
        <span>
          Compute gratuity — Payment of Gratuity Act, 1972. Due after five years
          of continuous service; a part-year of six months or more counts as a
          full year.
        </span>
      </label>
      {draft.gratuity_enabled && (
        <div className="pr-row">
          <label className="pr-field">
            <span className="pr-field-label">Days per completed year</span>
            <input type="number" min={0} max={90} value={draft.gratuity_days_per_year}
                   onChange={(e) => set('gratuity_days_per_year', Number(e.target.value))} />
            <span className="pr-field-hint">15 is the statutory figure.</span>
          </label>
          <label className="pr-field">
            <span className="pr-field-label">Divided by</span>
            <input type="number" min={1} max={31} value={draft.gratuity_month_days}
                   onChange={(e) => set('gratuity_month_days', Number(e.target.value))} />
            <span className="pr-field-hint">26 notional working days.</span>
          </label>
          <Amount label="Ceiling" paise={draft.gratuity_ceiling}
                  onChange={(v) => set('gratuity_ceiling', v)} />
        </div>
      )}

      <div className="pr-actions">
        <button className="btn primary" disabled={busy || pensionTooHigh} onClick={save}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
        {saved && <span className="ok-note">Saved</span>}
        <span className="muted">
          Applies to the next pay run computed. Runs already approved keep their
          own frozen figures.
        </span>
      </div>
    </section>
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
    <label className="pr-field">
      <span className="pr-field-label">{label}</span>
      <input value={text} inputMode="decimal" className={bad ? 'is-bad' : ''}
             onChange={(e) => {
               setText(e.target.value)
               const next = toBps(e.target.value)
               if (next !== null) onChange(next)
             }} />
      {hint && <span className="pr-field-hint">{hint}</span>}
    </label>
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
    <label className="pr-field">
      <span className="pr-field-label">{label}</span>
      <input value={text} inputMode="decimal"
             onChange={(e) => {
               setText(e.target.value)
               const next = toPaise(e.target.value)
               if (next !== null) onChange(next)
             }} />
      {hint && <span className="pr-field-hint">{hint}</span>}
    </label>
  )
}

function Slabs({
  slabs,
  state,
  onChanged,
  onError,
}: {
  slabs: PtSlab[]
  state: string | null
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
    <section className="card pr-form">
      <h2 className="card-title">
        Professional tax slabs{state ? ` · ${state}` : ''}
      </h2>
      {!slabs.length && (
        <p className="pr-warn">
          Professional tax is switched on with no slabs configured, so nothing is
          being deducted. Add the bands for your state.
        </p>
      )}

      <div className="pr-row">
        <label className="pr-field">
          <span className="pr-field-label">From</span>
          <input value={min} inputMode="decimal" placeholder="0"
                 onChange={(e) => setMin(e.target.value)} />
        </label>
        <label className="pr-field">
          <span className="pr-field-label">To</span>
          <input value={max} inputMode="decimal" placeholder="blank = no limit"
                 onChange={(e) => setMax(e.target.value)} />
        </label>
        <label className="pr-field">
          <span className="pr-field-label">Deduct</span>
          <input value={amount} inputMode="decimal" placeholder="200"
                 onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="pr-field">
          <span className="pr-field-label">Month</span>
          <select value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="">Every month</option>
            {MONTHS.map((name, index) => (
              <option key={name} value={index + 1}>{name}</option>
            ))}
          </select>
        </label>
        <button className="btn primary" disabled={!ready || busy}
                onClick={() => run(async () => {
                  await api.post('/statutory/slabs', {
                    min_gross: minPaise,
                    max_gross: max.trim() ? toPaise(max) : null,
                    amount: amountPaise,
                    applies_in_month: month ? Number(month) : null,
                  })
                  setMin(''); setMax(''); setAmount(''); setMonth('')
                })}>
          Add band
        </button>
      </div>

      {slabs.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Band</th><th>Month</th><th className="num">Deduct</th><th /></tr>
            </thead>
            <tbody>
              {slabs.map((slab) => (
                <tr key={slab.id}>
                  <td>
                    {money(slab.min_gross)} —{' '}
                    {slab.max_gross === null ? 'above' : money(slab.max_gross)}
                    {slab.label && <div className="muted">{slab.label}</div>}
                  </td>
                  <td>
                    {slab.applies_in_month
                      ? MONTHS[slab.applies_in_month - 1]
                      : <span className="muted">Every month</span>}
                  </td>
                  <td className="num">{money(slab.amount)}</td>
                  <td className="row-actions">
                    <button className="btn small danger" disabled={busy}
                            onClick={() => run(() =>
                              api.del(`/statutory/slabs/${slab.id}`))}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            A month-specific band wins over a general one covering the same
            range — which is how a state that charges differently in one month is
            expressed.
          </p>
        </div>
      )}
    </section>
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

  return (
    <section className="card pr-form">
      <h2 className="card-title">What would come off</h2>
      <p className="muted">
        Runs the same computation a pay run runs. Check it against your circular
        here rather than at month end.
      </p>
      {!configured && <Empty>Save the settings above first.</Empty>}

      <div className="pr-row">
        <label className="pr-field">
          <span className="pr-field-label">PF wages</span>
          <input value={pfWage} inputMode="decimal"
                 onChange={(e) => setPfWage(e.target.value)} />
          <span className="pr-field-hint">Usually basic. Components you flagged.</span>
        </label>
        <label className="pr-field">
          <span className="pr-field-label">ESI wages</span>
          <input value={esiWage} inputMode="decimal"
                 onChange={(e) => setEsiWage(e.target.value)} />
        </label>
        <label className="pr-field">
          <span className="pr-field-label">Salary gross</span>
          <input value={gross} inputMode="decimal"
                 onChange={(e) => setGross(e.target.value)} />
          <span className="pr-field-hint">For the PT band. Excludes reimbursements.</span>
        </label>
        <label className="pr-field">
          <span className="pr-field-label">Month</span>
          <select value={month} onChange={(e) => setMonth(e.target.value)}>
            {MONTHS.map((name, index) => (
              <option key={name} value={index + 1}>{name}</option>
            ))}
          </select>
        </label>
        <button className="btn" disabled={busy || !configured} onClick={run}>
          Compute
        </button>
      </div>

      {result && (
        <div className="pr-payslip-cols">
          <div>
            <h3 className="pr-subhead">Deducted from the employee</h3>
            {result.employee_lines.length ? (
              <table className="table pr-components">
                <tbody>
                  {result.employee_lines.map((line) => (
                    <tr key={line.code}>
                      <td>
                        <div className="pr-code">{line.code}</div>
                        <div className="muted">{line.detail ?? line.name}</div>
                      </td>
                      <td className="num">{money(line.amount)}</td>
                    </tr>
                  ))}
                  <tr className="pr-total-row">
                    <td>Total</td><td className="num">{money(result.employee_total)}</td>
                  </tr>
                </tbody>
              </table>
            ) : <p className="muted">Nothing.</p>}
          </div>
          <div>
            <h3 className="pr-subhead">Paid by the company on top</h3>
            {result.employer_lines.length ? (
              <table className="table pr-components">
                <tbody>
                  {result.employer_lines.map((line) => (
                    <tr key={line.code}>
                      <td>
                        <div className="pr-code">{line.code}</div>
                        <div className="muted">{line.detail ?? line.name}</div>
                      </td>
                      <td className="num">{money(line.amount)}</td>
                    </tr>
                  ))}
                  <tr className="pr-total-row">
                    <td>Total</td><td className="num">{money(result.employer_total)}</td>
                  </tr>
                </tbody>
              </table>
            ) : <p className="muted">Nothing.</p>}
          </div>
        </div>
      )}
    </section>
  )
}
