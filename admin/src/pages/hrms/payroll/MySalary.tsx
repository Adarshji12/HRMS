/* My salary — what I am paid, and how it has changed.

   Reads `/payroll/me`, which consults no permission at all: a person is
   entitled to know what they are paid. That is the only route in this module
   an employee can reach.

   The breakdown is shown, not just the gross, because "what is my basic" is the
   question every home-loan application and rent-allowance claim asks, and
   answering it currently means emailing HR. */

import { useQuery } from '../../../lib/useQuery'
import { api } from '../../../lib/api'
import { money } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type { SalaryStructure } from '../../../lib/types'
import { ruleOf } from './SalaryStructures'
import '../../../styles/payroll.css'

export default function MySalary() {
  const historyQ = useQuery<SalaryStructure[]>('my-salary', () =>
    api.get<SalaryStructure[]>('/payroll/me'),
  )

  if (historyQ.loading) return <Loading />
  if (historyQ.error) return <ErrorNote>{historyQ.error}</ErrorNote>

  const history = historyQ.data ?? []
  const current = history.find((row) => row.is_current) ?? history[0]

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>My salary</h1>
          <p className="muted">
            Your current structure and every revision of it.
          </p>
        </div>
      </header>

      {!current ? (
        <Empty>
          No salary structure is on file for you yet. Your HR administrator sets
          this up.
        </Empty>
      ) : (
        <>
          <div className="pr-tiles">
            <Tile label="Monthly gross" value={money(current.gross_monthly)}
                  meta={`effective ${current.effective_from}`} />
            <Tile label="Annual" value={money(current.annual_gross)}
                  meta="twelve months" />
            <Tile label="Basic"
                  value={money(
                    current.components.find((c) => c.calculation !== 'balance'
                      && c.is_pf_wage)?.amount ?? 0,
                  )}
                  meta="what PF is computed on" />
          </div>

          {history.map((structure) => (
            <section key={structure.id}
                     className={`card pr-revision${structure.is_current ? ' is-current' : ''}`}>
              <div className="pr-revision-head">
                <div>
                  <div className="pr-title">
                    {money(structure.gross_monthly)} a month
                    {structure.is_current && <span className="pr-pill">Current</span>}
                  </div>
                  <div className="muted">
                    {structure.effective_from} — {structure.effective_to ?? 'ongoing'}
                    {structure.reason ? ` · ${structure.reason}` : ''}
                  </div>
                </div>
              </div>
              <div className="table-wrap">
                <table className="table pr-components">
                  <thead>
                    <tr>
                      <th>Component</th><th>How</th>
                      <th className="num">Monthly</th><th className="num">Annual</th>
                    </tr>
                  </thead>
                  <tbody>
                    {structure.components.map((line) => (
                      <tr key={line.id}>
                        <td>
                          <div className="pr-code">{line.code}</div>
                          <div className="muted">{line.name}</div>
                        </td>
                        <td className="muted">{ruleOf(line)}</td>
                        <td className="num">{money(line.amount)}</td>
                        <td className="num muted">{money(line.amount * 12)}</td>
                      </tr>
                    ))}
                    <tr className="pr-total-row">
                      <td colSpan={2}>Gross</td>
                      <td className="num">{money(structure.gross_monthly)}</td>
                      <td className="num">{money(structure.annual_gross)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          ))}

          <p className="muted">
            This is your gross salary structure. Deductions — provident fund,
            ESI, tax — are computed at each pay run and are not shown here yet.
          </p>
        </>
      )}
    </div>
  )
}

function Tile({ label, value, meta }: { label: string; value: string; meta: string }) {
  return (
    <div className="pr-tile">
      <div className="pr-tile-label">{label}</div>
      <div className="pr-tile-value">{value}</div>
      <div className="pr-tile-meta">{meta}</div>
    </div>
  )
}
