/* Investment declaration — the employee's side of income tax.

   The regime comparison at the top is the most important thing on this page.
   The choice is the employee's and it is worth real money in both directions:
   somebody who assumes "I have 80C, so the old regime is better" can lose the
   whole amount, because the new regime's ₹12 lakh rebate wipes the liability
   outright at incomes where the old one does not. Showing one number would let
   that happen; showing both is the point.

   Three server truths this file is built around:

   1. **Declared and verified are two facts.** The table shows both, and
      `effective_amount` — what payroll is actually using — separately, because
      "why did my TDS jump in February" is answered by the difference between
      them.

   2. **A submitted declaration is still editable.** People genuinely do invest
      more in November than they said in April. Verification is what closes it,
      and the empty state says so rather than implying submission is final.

   3. **Caps are shown, not enforced by refusing.** Declaring ₹3,00,000 of 80C
      is allowed and ₹1,50,000 of it counts — the same thing the return would
      do — so the row says how much will actually be used. */

import { useCallback, useMemo, useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { money, toPaise } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type {
  EmployeeDocument,
  TaxDeclaration as Declaration,
  TaxEstimate,
  TaxItem,
  TaxRegime,
} from '../../../lib/types'
import '../../../styles/payroll.css'

/** The sections most people claim, with the label they know them by. Free text
 *  is still accepted — the server sums an unrecognised section rather than
 *  refusing it, so a Finance Act adding one does not block anybody. */
const SECTIONS: { section: string; label: string; hint: string }[] = [
  { section: '80C', label: 'PPF, ELSS, life insurance, principal repayment',
    hint: 'Capped at ₹1,50,000.' },
  { section: '80CCD1B', label: 'National Pension Scheme (extra)',
    hint: 'Capped at ₹50,000, over and above 80C.' },
  { section: '80D', label: 'Health insurance premium',
    hint: 'Capped at ₹1,00,000 including senior-citizen parents.' },
  { section: '80E', label: 'Education loan interest', hint: 'No cap.' },
  { section: '80G', label: 'Donations', hint: 'No cap here; limits apply on filing.' },
  { section: '80TTA', label: 'Savings account interest', hint: 'Capped at ₹10,000.' },
  { section: '24B', label: 'Home loan interest',
    hint: 'Capped at ₹2,00,000 for a self-occupied property.' },
  { section: 'HRA', label: 'House rent allowance exemption', hint: '' },
  { section: 'LTA', label: 'Leave travel allowance', hint: '' },
]

export default function TaxDeclarationPage() {
  const declarationQ = useQuery<Declaration>('tax-declaration', () =>
    api.get<Declaration>('/tax/declaration'),
  )
  const [error, setError] = useState<string | null>(null)

  if (declarationQ.loading) return <Loading />
  if (declarationQ.error) return <ErrorNote>{declarationQ.error}</ErrorNote>
  if (!declarationQ.data) return null

  return (
    <Body
      declaration={declarationQ.data}
      onChanged={declarationQ.reload}
      error={error}
      setError={setError}
    />
  )
}

function Body({
  declaration,
  onChanged,
  error,
  setError,
}: {
  declaration: Declaration
  onChanged: () => void
  error: string | null
  setError: (message: string | null) => void
}) {
  const [busy, setBusy] = useState(false)

  const act = useCallback(
    async (run: () => Promise<unknown>) => {
      setBusy(true)
      setError(null)
      try {
        await run()
        onChanged()
      } catch (caught) {
        setError((caught as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [onChanged, setError],
  )

  const declaredTotal = declaration.items.reduce(
    (sum, item) => sum + item.effective_amount, 0,
  )

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Investment declaration</h1>
          <p className="muted">
            {declaration.year_label} · what you expect to invest this year.
            Payroll uses it to work out your monthly tax.
          </p>
        </div>
        <span className={`pr-status pr-status-${
          declaration.status === 'verified' ? 'ok'
            : declaration.status === 'submitted' ? 'go'
              : declaration.status === 'rejected' ? 'bad' : 'muted'}`}>
          {declaration.status.replace(/^./, (c) => c.toUpperCase())}
        </span>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}
      {declaration.provisional && (
        <p className="pr-warn">
          The tax rates for {declaration.year_label} have been carried forward
          from the previous year and may change when the Finance Act is passed.
          Treat these figures as an estimate.
        </p>
      )}

      <RegimeChoice declaration={declaration} busy={busy} act={act} />
      <Comparison declaration={declaration} onError={setError} />

      <section className="card pr-form">
        <h2 className="card-title">What you are claiming</h2>
        {declaration.regime === 'new' && (
          <p className="muted">
            The new regime allows none of these. They are kept so you can switch
            to the old regime and see the difference — nothing below affects your
            tax while the new regime is selected.
          </p>
        )}

        {!declaration.items.length ? (
          <Empty>Nothing declared yet. Add a claim below.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Section</th><th className="num">Declared</th>
                  <th className="num">Counted</th><th>Proof</th><th />
                </tr>
              </thead>
              <tbody>
                {declaration.items.map((item) => (
                  <ItemRow key={item.id} item={item} declaration={declaration}
                           busy={busy} act={act} />
                ))}
                <tr className="pr-total-row">
                  <td>Total counted</td>
                  <td />
                  <td className="num">{money(declaredTotal)}</td>
                  <td colSpan={2} />
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {declaration.can_edit && (
          <AddClaim declaration={declaration} busy={busy} act={act} />
        )}
      </section>

      {declaration.can_edit && (
        <div className="pr-actions">
          <button className="btn primary" disabled={busy}
                  onClick={() => act(() =>
                    api.post(`/tax/declaration/${declaration.id}/submit`))}>
            {declaration.status === 'draft' ? 'Submit declaration' : 'Resubmit'}
          </button>
          <span className="muted">
            Submitting tells payroll to start using it. You can still change it
            afterwards — HR verifying your proofs is what closes it.
          </span>
        </div>
      )}
      {declaration.status === 'verified' && (
        <p className="muted">
          Verified{declaration.verified_by_name
            ? ` by ${declaration.verified_by_name}` : ''}. Payroll is now using
          the amounts your proofs support. Ask HR to reopen it if something has
          changed.
        </p>
      )}
    </div>
  )
}

function RegimeChoice({
  declaration,
  busy,
  act,
}: {
  declaration: Declaration
  busy: boolean
  act: (run: () => Promise<unknown>) => Promise<void>
}) {
  return (
    <section className="card pr-form">
      <h2 className="card-title">Which regime</h2>
      <div className="pr-regimes">
        {(['new', 'old'] as TaxRegime[]).map((regime) => (
          <button
            key={regime}
            type="button"
            className={`pr-regime${declaration.regime === regime ? ' is-on' : ''}`}
            disabled={busy || !declaration.can_edit}
            aria-pressed={declaration.regime === regime}
            onClick={() => act(() =>
              api.post(`/tax/declaration/${declaration.id}/regime`, { regime }))}
          >
            <div className="pr-regime-name">
              {regime === 'new' ? 'New regime' : 'Old regime'}
            </div>
            <div className="pr-regime-hint">
              {regime === 'new'
                ? 'Lower rates and a ₹75,000 standard deduction, but no 80C, 80D or HRA.'
                : 'Higher rates, but every deduction and exemption below counts.'}
            </div>
          </button>
        ))}
      </div>
      {!declaration.can_edit && (
        <p className="muted">
          Your declaration is closed for the year, so the regime cannot be
          changed here.
        </p>
      )}
    </section>
  )
}

/** Both regimes side by side. The comparison is the point of the choice. */
function Comparison({
  declaration,
  onError,
}: {
  declaration: Declaration
  onError: (message: string) => void
}) {
  const [income, setIncome] = useState('')
  const [estimate, setEstimate] = useState<TaxEstimate | null>(null)
  const [busy, setBusy] = useState(false)

  const paise = toPaise(income)

  async function run() {
    if (!paise) return
    setBusy(true)
    try {
      setEstimate(await api.get<TaxEstimate>(
        `/tax/declaration/${declaration.id}/estimate?annual_income=${paise}`,
      ))
    } catch (caught) {
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const better = useMemo(() => {
    if (!estimate) return null
    if (estimate.old.total_tax === estimate.new.total_tax) return null
    return estimate.old.total_tax < estimate.new.total_tax ? 'old' : 'new'
  }, [estimate])

  return (
    <section className="card pr-form">
      <h2 className="card-title">Compare the two</h2>
      <div className="pr-row">
        <label className="pr-field">
          <span className="pr-field-label">Annual salary</span>
          <input value={income} inputMode="decimal" placeholder="1200000"
                 className={income && paise === null ? 'is-bad' : ''}
                 onChange={(e) => { setIncome(e.target.value); setEstimate(null) }} />
          <span className="pr-field-hint">
            Your taxable salary for the year. Your payslip shows the monthly
            figure.
          </span>
        </label>
        <button className="btn" disabled={!paise || busy} onClick={run}>
          Compare
        </button>
      </div>

      {estimate && (
        <>
          <div className="pr-payslip-cols">
            {(['new', 'old'] as const).map((regime) => {
              const side = estimate[regime]
              return (
                <div key={regime}
                     className={`pr-estimate${better === regime ? ' is-better' : ''}`}>
                  <h3 className="pr-subhead">
                    {regime === 'new' ? 'New regime' : 'Old regime'}
                    {better === regime && <span className="pr-pill">Lower</span>}
                    {estimate.chosen === regime && <span className="pr-pill">Chosen</span>}
                  </h3>
                  <table className="table pr-components">
                    <tbody>
                      <tr><td>Salary</td><td className="num">{money(side.gross_income)}</td></tr>
                      <tr><td>Standard deduction</td>
                          <td className="num">−{money(side.standard_deduction)}</td></tr>
                      <tr><td>Deductions claimed</td>
                          <td className="num">−{money(side.chapter_via)}</td></tr>
                      <tr><td>Taxable</td>
                          <td className="num">{money(side.taxable_income)}</td></tr>
                      {side.slab_working.map(([label, , amount]) => (
                        <tr key={label} className="pr-slab">
                          <td className="muted">{label}</td>
                          <td className="num muted">{money(amount)}</td>
                        </tr>
                      ))}
                      {side.rebate > 0 && (
                        <tr><td>Rebate (87A)</td>
                            <td className="num">−{money(side.rebate)}</td></tr>
                      )}
                      {side.surcharge > 0 && (
                        <tr><td>Surcharge</td>
                            <td className="num">{money(side.surcharge)}</td></tr>
                      )}
                      <tr><td>Cess</td><td className="num">{money(side.cess)}</td></tr>
                      <tr className="pr-total-row">
                        <td>Tax for the year</td>
                        <td className="num">{money(side.total_tax)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )
            })}
          </div>
          {better && better !== estimate.chosen && (
            <p className="pr-warn">
              The {better === 'old' ? 'old' : 'new'} regime would cost{' '}
              {money(Math.abs(estimate.old.total_tax - estimate.new.total_tax))} less
              at this salary, and you have chosen the other one.
            </p>
          )}
        </>
      )}
    </section>
  )
}

function ItemRow({
  item,
  declaration,
  busy,
  act,
}: {
  item: TaxItem
  declaration: Declaration
  busy: boolean
  act: (run: () => Promise<unknown>) => Promise<void>
}) {
  const known = SECTIONS.find((s) => s.section === item.section)
  const overCap = item.cap !== null && item.declared_amount > item.cap

  return (
    <tr>
      <td>
        <div className="pr-code">{item.section}</div>
        <div className="muted">{item.label || known?.label || ''}</div>
      </td>
      <td className="num">
        {money(item.declared_amount)}
        {overCap && (
          <div className="pr-warn">capped at {money(item.cap!)}</div>
        )}
      </td>
      <td className="num">
        {money(item.effective_amount)}
        <div className="muted">
          {item.status === 'verified' ? 'verified'
            : item.status === 'rejected' ? 'rejected'
              : item.verified_amount !== null ? 'checked' : 'as declared'}
        </div>
      </td>
      <td>
        {item.document_id
          ? <span className="pr-yes">✓</span>
          : <span className="muted">—</span>}
      </td>
      <td className="row-actions">
        {declaration.can_edit && (
          <button className="btn small danger" disabled={busy}
                  onClick={() => act(() => api.del(`/tax/items/${item.id}`))}>
            Remove
          </button>
        )}
      </td>
    </tr>
  )
}

function AddClaim({
  declaration,
  busy,
  act,
}: {
  declaration: Declaration
  busy: boolean
  act: (run: () => Promise<unknown>) => Promise<void>
}) {
  const [section, setSection] = useState(SECTIONS[0].section)
  const [amount, setAmount] = useState('')
  const [documentId, setDocumentId] = useState('')

  const docsQ = useQuery<EmployeeDocument[]>('my-tax-documents', () =>
    api.get<EmployeeDocument[]>(`/people/${declaration.user_id}/documents`),
  )
  const chosen = SECTIONS.find((s) => s.section === section)
  const paise = toPaise(amount)

  return (
    <div className="pr-row pr-addclaim">
      <label className="pr-field">
        <span className="pr-field-label">Section</span>
        <select value={section} onChange={(e) => setSection(e.target.value)}>
          {SECTIONS.map((option) => (
            <option key={option.section} value={option.section}>
              {option.section} — {option.label}
            </option>
          ))}
        </select>
        {chosen?.hint && <span className="pr-field-hint">{chosen.hint}</span>}
      </label>
      <label className="pr-field">
        <span className="pr-field-label">Amount</span>
        <input value={amount} inputMode="decimal" placeholder="150000"
               className={amount && paise === null ? 'is-bad' : ''}
               onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label className="pr-field">
        <span className="pr-field-label">Proof</span>
        <select value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
          <option value="">Attach later</option>
          {(docsQ.data ?? []).map((doc) => (
            <option key={doc.id} value={doc.id}>
              {doc.title || doc.file_name || doc.doc_type}
            </option>
          ))}
        </select>
        <span className="pr-field-hint">
          From your documents. Upload it under My profile first.
        </span>
      </label>
      <button className="btn primary" disabled={!paise || busy}
              onClick={() => act(async () => {
                const updated = await api.post<Declaration>(
                  `/tax/declaration/${declaration.id}/items`,
                  { section, declared_amount: paise, label: chosen?.label ?? null },
                )
                if (documentId) {
                  const item = updated.items.find((row) => row.section === section)
                  if (item) {
                    await api.post(`/tax/items/${item.id}/proof`,
                                   { document_id: documentId })
                  }
                }
                setAmount('')
                setDocumentId('')
              })}>
        Add claim
      </button>
    </div>
  )
}
