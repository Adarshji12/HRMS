/* Year end — reconcile the year, then issue Form 16.

   The thing this screen has to explain, because it looks like a bug otherwise:
   **part-way through a year the balance reads as over-deducted.** TDS is taken
   against a twelve-month projection, while the reconciliation computes tax on
   the months actually paid — so in July, four months of deduction sit against
   four months of a liability the rebate may wipe entirely. It only means "over-
   deducted" once the year is complete, and `months_covered` is what tells you
   which of the two you are looking at. The banner says so rather than letting
   somebody chase a refund in July.

   Two server truths:

   1. **Reconciliation moves; a certificate does not.** The list recomputes on
      every read from frozen payslips; issuing copies those figures onto a row
      that never changes. Both are shown, because the difference between them is
      what a March correction is.

   2. **A correction is a revision.** Issuing again supersedes rather than
      editing — somebody may already have filed against the first one — so the
      button says "Issue revision" once one exists. */

import { useCallback, useState } from 'react'
import { api, openPrintable } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { money } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type { Form16, Reconciliation } from '../../../lib/types'
import '../../../styles/payroll.css'

function currentFinancialYear(): number {
  const now = new Date()
  // April to March. One place, because computing it inline is wrong for
  // exactly three months of the year.
  return now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1
}

export default function YearEnd() {
  const [year, setYear] = useState(currentFinancialYear)
  const rowsQ = useQuery<Reconciliation[]>(`reconcile-${year}`, () =>
    api.get<Reconciliation[]>(`/form16/reconcile?financial_year=${year}`),
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const issue = useCallback(
    async (userId: string) => {
      setBusy(true)
      setError(null)
      try {
        await api.post(`/form16/issue/${userId}`, { financial_year: year })
        rowsQ.reload()
      } catch (caught) {
        setError((caught as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [year, rowsQ],
  )

  const rows = rowsQ.data ?? []
  const partial = rows.some((row) => row.months_covered < 12)
  const totals = rows.reduce(
    (sum, row) => ({
      gross: sum.gross + row.gross_salary,
      tds: sum.tds + row.tds_deducted,
      due: sum.due + row.total_tax,
    }),
    { gross: 0, tds: 0, due: 0 },
  )

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Year end</h1>
          <p className="muted">
            What was deducted against what was finally due, and the Form 16 that
            states it.
          </p>
        </div>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}
                aria-label="Financial year">
          {[year + 1, year, year - 1, year - 2].map((value) => (
            <option key={value} value={value}>
              FY {value}-{String(value + 1).slice(-2)}
            </option>
          ))}
        </select>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      {partial && (
        <p className="pr-warn">
          Some of these cover fewer than twelve months. TDS is deducted against a
          projection of the whole year, so a part-year reconciliation will show
          more deducted than due — that is expected, not an over-deduction.
          It only means what it says once the year is complete.
        </p>
      )}

      {rowsQ.loading ? (
        <Loading />
      ) : rowsQ.error ? (
        <ErrorNote>{rowsQ.error}</ErrorNote>
      ) : !rows.length ? (
        <Empty>No approved payroll in that year.</Empty>
      ) : (
        <>
          <div className="pr-tiles">
            <Tile label="Salary paid" value={money(totals.gross)}
                  meta={`${rows.length} employees`} />
            <Tile label="TDS deducted" value={money(totals.tds)} meta="across the year" />
            <Tile label="Tax due" value={money(totals.due)}
                  meta="on the months covered" />
          </div>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Employee</th><th className="num">Months</th>
                  <th className="num">Salary</th><th className="num">Taxable</th>
                  <th className="num">Tax due</th><th className="num">TDS</th>
                  <th className="num">Balance</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.user_id}>
                    <td>
                      <div className="pr-title">{row.user_name}</div>
                      <div className="muted">
                        {row.regime === 'new' ? 'New regime' : 'Old regime'}
                        {row.age_band !== 'below_60'
                          ? ` · ${row.age_band === 'senior' ? 'senior' : 'super senior'}`
                          : ''}
                      </div>
                    </td>
                    <td className="num">
                      {row.months_covered}
                      {row.months_covered < 12 && (
                        <div className="muted">of 12</div>
                      )}
                    </td>
                    <td className="num">{money(row.gross_salary)}</td>
                    <td className="num">{money(row.taxable_income)}</td>
                    <td className="num">{money(row.total_tax)}</td>
                    <td className="num">{money(row.tds_deducted)}</td>
                    <td className="num">
                      {row.balance === 0 ? (
                        <span className="muted">nil</span>
                      ) : row.balance > 0 ? (
                        <span className="ln-warn">{money(row.balance)} to take</span>
                      ) : (
                        <span className="pr-yes">
                          {money(-row.balance)} ahead
                        </span>
                      )}
                    </td>
                    <td className="row-actions">
                      <button className="btn small" disabled={busy}
                              onClick={() => issue(row.user_id)}>
                        {row.issued ? 'Issue revision' : 'Issue Form 16'}
                      </button>
                      <Certificates userId={row.user_id} onError={setError} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">
              “To take” is what March payroll still has to deduct. “Ahead” means
              more has been deducted than the months covered require — over a
              complete year that is a refund the employee claims on their return,
              because payroll cannot refund TDS.
            </p>
          </div>
        </>
      )}
    </div>
  )
}

function Certificates({
  userId,
  onError,
}: {
  userId: string
  onError: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const listQ = useQuery<Form16[]>(open ? `form16-${userId}` : '', () =>
    api.get<Form16[]>(`/form16/employee/${userId}`),
  )

  if (!open) {
    return (
      <button className="btn small" onClick={() => setOpen(true)}>
        Certificates
      </button>
    )
  }
  return (
    <div className="pr-certs">
      {(listQ.data ?? []).length === 0 ? (
        <span className="muted">None issued.</span>
      ) : (
        (listQ.data ?? []).map((cert) => (
          <button key={cert.id} className="link-btn"
                  onClick={() =>
                    openPrintable(`/form16/${cert.id}/print`)
                      .catch((caught) => onError((caught as Error).message))}>
            {cert.reference_no}
            {cert.revision > 1 ? ` (rev ${cert.revision})` : ''}
            {cert.status === 'revised' ? ' — superseded' : ''}
          </button>
        ))
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

/* --- employee self-service ------------------------------------------------ */

/** "My Form 16" — the certificates issued to me, newest first. */
export function MyForm16() {
  const listQ = useQuery<Form16[]>('my-form16', () =>
    api.get<Form16[]>('/form16/mine'),
  )
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>My Form 16</h1>
          <p className="muted">
            Your annual tax certificates. Part B — the salary and tax
            computation. Part A comes from the income-tax portal.
          </p>
        </div>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      {listQ.loading ? (
        <Loading />
      ) : listQ.error ? (
        <ErrorNote>{listQ.error}</ErrorNote>
      ) : !listQ.data?.length ? (
        <Empty>No certificates have been issued to you yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Year</th><th>Reference</th><th className="num">Salary</th>
                <th className="num">Tax</th><th className="num">TDS</th><th />
              </tr>
            </thead>
            <tbody>
              {listQ.data.map((cert) => (
                <tr key={cert.id} className={cert.status === 'revised' ? 'is-off' : ''}>
                  <td>
                    FY {cert.financial_year}-{String(cert.financial_year + 1).slice(-2)}
                    {cert.revision > 1 && (
                      <div className="muted">revision {cert.revision}</div>
                    )}
                  </td>
                  <td>
                    {cert.reference_no}
                    {cert.status === 'revised' && (
                      <div className="muted">superseded</div>
                    )}
                  </td>
                  <td className="num">{money(cert.gross_salary)}</td>
                  <td className="num">{money(cert.total_tax)}</td>
                  <td className="num">{money(cert.tds_deducted)}</td>
                  <td className="row-actions">
                    <button className="btn small"
                            onClick={() =>
                              openPrintable(`/form16/${cert.id}/print`)
                                .catch((caught) => setError((caught as Error).message))}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
