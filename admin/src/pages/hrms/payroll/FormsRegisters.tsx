/* Forms & Registers: every tax, salary and compliance document, with whether it can be produced yet.

   A card is only offered when the server can really make it; the rest say plainly what is missing,
   rather than a button that would produce an empty file. */

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, download } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { ErrorNote } from '../../../components/ui'
import type { PayRun } from '../../../lib/types'
import '../../../styles/payroll.css'

type State = 'ready' | 'setup' | 'soon'
interface Card {
  n: string; title: string; blurb: string
  state: (ctx: Ctx) => { state: State; note?: string }
  action?: { label: string; run: (ctx: Ctx) => Promise<void> | void }
}
interface Ctx { run: PayRun | null; frozen: boolean; go: (to: string) => void }

const FROZEN = ['approved', 'paid']
const needRun = (c: Ctx) => (c.run ? (c.frozen ? { state: 'ready' as State } : { state: 'setup' as State, note: `The ${c.run.period_label} run is ${c.run.status}. Approve it first.` }) : { state: 'setup' as State, note: 'Needs at least one payroll run.' })
const soon = (note: string) => () => ({ state: 'soon' as State, note })

const TAX: Card[] = [
  { n: '01', title: 'Form 16 – Part B', blurb: 'The salary and tax annexure, per employee, for a financial year.',
    state: (c) => (c.run ? { state: 'ready' } : { state: 'setup', note: 'Needs at least one payroll run.' }),
    action: { label: 'Open Year end & Form 16', run: (c) => c.go('/payroll/year-end') } },
  { n: '02', title: 'Salary Certificate', blurb: 'Signed confirmation of current salary, for a bank or a landlord.',
    state: soon('There is no certificate template yet. Payslips for any month can be printed from Salary slips.') },
  { n: '03', title: 'Annual Salary Statement', blurb: 'One employee’s twelve months — earnings, deductions and net, side by side.',
    state: soon('Not built yet. Salary slips shows each month’s payslip for any employee.') },
  { n: '04', title: 'Payroll / Salary Register', blurb: 'Every employee, for a month, in one register.',
    state: needRun,
    action: { label: 'Download CSV', run: async (c) => { if (c.run) await download(`/payruns/${c.run.id}/register.csv`, `register-${c.run.period_label}.csv`) } } },
  { n: '05', title: 'TDS Deduction Statement', blurb: 'Tax deducted month by month, per employee, with the PAN it sits against.',
    state: soon('TDS is entered each month, not computed, and no PAN is held per employee for this statement yet.') },
  { n: '06', title: 'TDS Summary – Employee Wise', blurb: 'One line per employee: gross paid and total tax deducted for the year.',
    state: soon('Needs TDS entered on payslips, which this version does not compute.') },
  { n: '07', title: 'Investment Declaration / Proof Statement', blurb: 'What each employee declared under 80C and the rest, and what they proved.',
    state: () => ({ state: 'ready' }),
    action: { label: 'Open Tax declarations', run: (c) => c.go('/payroll/tax') } },
  { n: '08', title: 'Tax Computation Sheet', blurb: 'How the year’s tax was arrived at — income, exemptions, regime, liability.',
    state: soon('There is no projected income or regime computation. A sheet showing the arithmetic would be inventing it.') },
  { n: '09', title: 'Form 12BA', blurb: 'Perquisites, amenities and profits in lieu of salary.',
    state: soon('Perquisites are not recorded anywhere in this payroll, so there is nothing to report.') },
  { n: '10', title: 'Form 24Q / TDS Return Data', blurb: 'Annexure I deductee data for a quarter, as a file for the return utility.',
    state: soon('Needs TDS computed on payslips and the company TAN, neither of which is held yet.') },
]

const COMPLIANCE: Card[] = [
  { n: '11', title: 'PF / EPF Report', blurb: 'PF wages and both contributions, with UAN, for the monthly ECR.',
    state: needRun,
    action: { label: 'Download ECR', run: async (c) => { if (c.run) await download(`/payruns/${c.run.id}/pf-ecr`, `pf-ecr-${c.run.period_label}.txt`) } } },
  { n: '12', title: 'ESI Report', blurb: 'ESIC wages and contributions, with the insurance number.',
    state: needRun,
    action: { label: 'Download CSV', run: async (c) => { if (c.run) await download(`/payruns/${c.run.id}/esi-return`, `esi-${c.run.period_label}.csv`) } } },
  { n: '13', title: 'Professional Tax Report', blurb: 'PT deducted per employee, by state slab, for the monthly challan.',
    state: soon('Not built yet. Professional tax appears on each payslip as a deduction line.') },
  { n: '14', title: 'Labour Welfare Fund Report', blurb: 'LWF deducted from employees and contributed by the company.',
    state: soon('Needs a salary component with the code LWF, which is not set up.') },
  { n: '15', title: 'TDS Challan / Payment Summary', blurb: 'Tax deducted per month against what was deposited, with CIN and BSR.',
    state: soon('Deposits are not recorded here, so there is nothing to reconcile against.') },
  { n: '16', title: 'Payroll Deduction Report', blurb: 'Every deduction head together — PF, ESI, PT, TDS, advances and loans.',
    state: soon('Not built yet. The Payroll register carries total deductions per employee.') },
]

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const QUARTERS = [{ v: 'q1', l: 'Q1 (Apr-Jun)', m: [4, 5, 6] }, { v: 'q2', l: 'Q2 (Jul-Sep)', m: [7, 8, 9] }, { v: 'q3', l: 'Q3 (Oct-Dec)', m: [10, 11, 12] }, { v: 'q4', l: 'Q4 (Jan-Mar)', m: [1, 2, 3] }]

export default function FormsRegisters() {
  const navigate = useNavigate()
  const runsQ = useQuery<PayRun[]>('pay-runs', () => api.get<PayRun[]>('/payruns'))
  const now = new Date()
  const [fy, setFy] = useState(now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1)
  const [month, setMonth] = useState(0)
  const [quarter, setQuarter] = useState('')
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busyN, setBusyN] = useState<string | null>(null)

  const inFy = (r: PayRun) => (r.period_month >= 4 ? r.period_year === fy : r.period_year === fy + 1)
  const run = useMemo(() => {
    const qm = QUARTERS.find((q) => q.v === quarter)?.m
    const ok = (runsQ.data ?? []).filter((r) => r.status !== 'cancelled' && inFy(r)
      && (!month || r.period_month === month) && (!qm || qm.includes(r.period_month)))
    const frozen = ok.filter((r) => FROZEN.includes(r.status))
    const pool = frozen.length ? frozen : ok
    return [...pool].sort((a, b) => (b.period_year - a.period_year) || (b.period_month - a.period_month))[0] ?? null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runsQ.data, fy, month, quarter])
  const ctx: Ctx = { run, frozen: run ? FROZEN.includes(run.status) : false, go: (to) => navigate(to) }
  const years = [fy - 1, fy, fy + 1].filter((v, i, a) => a.indexOf(v) === i)
  const q = search.trim().toLowerCase()
  const match = (c: Card) => !q || c.title.toLowerCase().includes(q) || c.blurb.toLowerCase().includes(q)

  async function act(card: Card) {
    setError(null); setBusyN(card.n)
    try { await card.action?.run(ctx) } catch (caught) { setError((caught as Error).message) } finally { setBusyN(null) }
  }

  const section = (title: string, blurb: string, cards: Card[]) => {
    const shown = cards.filter(match)
    if (!shown.length) return null
    return (
      <section style={{ marginTop: 22 }}>
        <h2 className="card-title" style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>{title} <span className="muted-sm" style={{ fontWeight: 400 }}>{blurb}</span></h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14, marginTop: 12 }}>
          {shown.map((card) => {
            const s = card.state(ctx)
            return (
              <article key={card.n} className="card" style={{ padding: 16, display: 'grid', gap: 10, alignContent: 'start' }}>
                <div><span className="muted-sm">{card.n}</span> <b>{card.title}</b></div>
                <p className="muted-sm" style={{ margin: 0 }}>{card.blurb}</p>
                {s.state === 'ready' && card.action ? (
                  <button className="btn btn-primary small" disabled={busyN === card.n} onClick={() => void act(card)}>{busyN === card.n ? 'Preparing…' : card.action.label}</button>
                ) : s.state === 'ready' ? null : (
                  <div style={{ background: '#fff4e5', border: '1px solid #fde0b8', borderRadius: 10, padding: '10px 12px', fontSize: 12.5, color: '#8a4b08' }}>
                    <b>{s.state === 'soon' ? 'Not available yet' : 'Needs setup'}</b>
                    <div style={{ marginTop: 4 }}>{s.note}</div>
                  </div>
                )}
                {s.state === 'ready' && card.action && run && card.n !== '01' && card.n !== '07' && (
                  <span className="muted-sm">For {run.period_label}</span>
                )}
              </article>
            )
          })}
        </div>
      </section>
    )
  }

  return (
    <div className="page">
      <p className="muted" style={{ marginTop: 0 }}>Generate, view and download payroll, tax and statutory forms and registers.</p>
      {error && <ErrorNote>{error}</ErrorNote>}
      <section className="card" style={{ padding: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14 }}>
          <label className="pr-field"><span className="pr-field-label">FINANCIAL YEAR</span>
            <select value={fy} onChange={(e) => setFy(Number(e.target.value))}>
              {years.map((y) => <option key={y} value={y}>FY {y}-{String(y + 1).slice(2)}</option>)}
            </select></label>
          <label className="pr-field"><span className="pr-field-label">MONTH</span>
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              <option value={0}>All months</option>
              {[4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3].map((m) => <option key={m} value={m}>{MONTHS[m - 1]}</option>)}
            </select></label>
          <label className="pr-field"><span className="pr-field-label">QUARTER</span>
            <select value={quarter} onChange={(e) => setQuarter(e.target.value)}>
              <option value="">All quarters</option>
              {QUARTERS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select></label>
          <label className="pr-field"><span className="pr-field-label">SEARCH</span>
            <input placeholder="Form name" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        </div>
        <p className="muted-sm" style={{ margin: '12px 0 0' }}>
          {run ? `Monthly files use the ${run.period_label} run (${run.status}).` : 'No payroll run matches these filters.'}
        </p>
      </section>
      {section('Tax & Salary Forms', 'What an employee needs for their own return, a bank or a new employer.', TAX)}
      {section('Compliance Reports', 'What the company files — PF, ESI, professional tax and TDS.', COMPLIANCE)}
    </div>
  )
}
