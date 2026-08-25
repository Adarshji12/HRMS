/* Pay components — the catalogue a salary structure is assembled from.

   The three statutory checkboxes are the point of this screen, not the
   percentages. PF wages, ESI wages and taxable are the entire interface between
   a company's salary design and statutory computation; nothing downstream
   infers them from a component's name, because "Basic" is a convention and a
   payroll engine that guesses from a string is one rename away from an incorrect
   filing.

   Two rules the server enforces and this form explains rather than hides:
   exactly one component may be flagged basic (percent-of-basic refers to it),
   and exactly one may absorb the balance of gross (two would each want the same
   remainder).

   Editing a component changes the *next* structure and nothing about existing
   ones, which every structure's own snapshot guarantees. The note at the bottom
   says so, because an administrator raising HRA from 40% to 50% needs to know it
   will not retroactively repay anybody. */

import { useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type { Calculation, PayComponent } from '../../../lib/types'
import { pct, ruleOf } from './SalaryStructures'
import '../../../styles/payroll.css'

const CALCULATIONS: { value: Calculation; label: string; hint: string }[] = [
  { value: 'fixed', label: 'Fixed amount', hint: 'Stated per employee.' },
  { value: 'percent_of_gross', label: '% of gross', hint: 'Of monthly gross.' },
  { value: 'percent_of_basic', label: '% of basic', hint: 'Of the basic component.' },
  { value: 'balance', label: 'Balance of gross', hint: 'Whatever is left. One only.' },
]

const BLANK = {
  code: '',
  name: '',
  calculation: 'fixed' as Calculation,
  rate: '',
  is_basic: false,
  is_pf_wage: false,
  is_esi_wage: true,
  is_taxable: true,
  sort_order: '100',
}

export default function PayComponents() {
  const listQ = useQuery<PayComponent[]>('pay-components-all', () =>
    api.get<PayComponent[]>('/payroll/components'),
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      listQ.reload()
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Pay components</h1>
          <p className="muted">
            The lines a payslip can carry. The three statutory flags on each are
            what PF, ESI and tax will be computed from.
          </p>
        </div>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      <NewComponent busy={busy} onCreate={(body) =>
        run(() => api.post('/payroll/components', body))} />

      {listQ.loading ? (
        <Loading />
      ) : listQ.error ? (
        <ErrorNote>{listQ.error}</ErrorNote>
      ) : !listQ.data?.length ? (
        <Empty>
          No components yet. A typical Indian structure is Basic (40% of gross),
          HRA (50% of basic), a fixed conveyance allowance, and a special
          allowance absorbing the balance.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th><th>Name</th><th>How</th>
                <th>PF</th><th>ESI</th><th>Tax</th>
                <th className="num">Used by</th><th>Active</th><th />
              </tr>
            </thead>
            <tbody>
              {listQ.data.map((component) => (
                <tr key={component.id} className={component.is_active ? '' : 'is-off'}>
                  <td>
                    <div className="pr-code">{component.code}</div>
                    {component.is_basic && <span className="pr-pill">Basic</span>}
                  </td>
                  <td>
                    {component.name}
                    {component.description && (
                      <div className="muted">{component.description}</div>
                    )}
                  </td>
                  <td className="muted">{ruleOf(component)}</td>
                  <td>
                    <Toggle on={component.is_pf_wage} busy={busy}
                            onToggle={() => run(() =>
                              api.patch(`/payroll/components/${component.id}`,
                                        { is_pf_wage: !component.is_pf_wage }))} />
                  </td>
                  <td>
                    <Toggle on={component.is_esi_wage} busy={busy}
                            onToggle={() => run(() =>
                              api.patch(`/payroll/components/${component.id}`,
                                        { is_esi_wage: !component.is_esi_wage }))} />
                  </td>
                  <td>
                    <Toggle on={component.is_taxable} busy={busy}
                            onToggle={() => run(() =>
                              api.patch(`/payroll/components/${component.id}`,
                                        { is_taxable: !component.is_taxable }))} />
                  </td>
                  <td className="num">{component.usage_count}</td>
                  <td>{component.is_active ? 'Yes' : <span className="muted">No</span>}</td>
                  <td className="row-actions">
                    <button className="btn small" disabled={busy}
                            onClick={() => run(() =>
                              api.patch(`/payroll/components/${component.id}`,
                                        { is_active: !component.is_active }))}>
                      {component.is_active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Editing a component changes the next structure built from it and
            nothing about existing ones — every structure keeps its own snapshot,
            so a payslip from last year still explains itself the way it did
            then. A component that has ever been used cannot be deleted;
            deactivating retires it.
          </p>
        </div>
      )}
    </div>
  )
}

/** A statutory flag, toggled in place. Three of these per row is why they are
 *  a compact control rather than a checkbox with a label. */
function Toggle({
  on,
  busy,
  onToggle,
}: {
  on: boolean
  busy: boolean
  onToggle: () => void
}) {
  return (
    <button type="button" className={`pr-toggle${on ? ' is-on' : ''}`}
            disabled={busy} aria-pressed={on} onClick={onToggle}>
      {on ? '✓' : '—'}
    </button>
  )
}

function NewComponent({
  busy,
  onCreate,
}: {
  busy: boolean
  onCreate: (body: Record<string, unknown>) => void
}) {
  const [draft, setDraft] = useState({ ...BLANK })
  const needsRate =
    draft.calculation === 'percent_of_basic' || draft.calculation === 'percent_of_gross'
  const rateBps = draft.rate.trim() ? Math.round(Number(draft.rate) * 100) : 0
  const rateBad = needsRate && (!Number.isFinite(rateBps) || rateBps <= 0)

  function submit() {
    onCreate({
      code: draft.code.trim(),
      name: draft.name.trim(),
      kind: 'earning',
      calculation: draft.calculation,
      rate_bps: needsRate ? rateBps : 0,
      is_basic: draft.is_basic,
      is_pf_wage: draft.is_pf_wage,
      is_esi_wage: draft.is_esi_wage,
      is_taxable: draft.is_taxable,
      sort_order: Number(draft.sort_order) || 100,
    })
    setDraft({ ...BLANK })
  }

  return (
    <section className="card pr-form">
      <h2 className="card-title">Add a component</h2>
      <div className="pr-row">
        <label className="pr-field">
          <span className="pr-field-label">Code</span>
          <input value={draft.code} placeholder="BASIC"
                 onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
        </label>
        <label className="pr-field pr-field-wide">
          <span className="pr-field-label">Name</span>
          <input value={draft.name} placeholder="Basic"
                 onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label className="pr-field">
          <span className="pr-field-label">How</span>
          <select value={draft.calculation}
                  onChange={(e) =>
                    setDraft({ ...draft, calculation: e.target.value as Calculation })}>
            {CALCULATIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        {needsRate && (
          <label className="pr-field">
            <span className="pr-field-label">Rate %</span>
            <input value={draft.rate} inputMode="decimal" placeholder="40"
                   className={rateBad ? 'is-bad' : ''}
                   onChange={(e) => setDraft({ ...draft, rate: e.target.value })} />
          </label>
        )}
        <label className="pr-field">
          <span className="pr-field-label">Order</span>
          <input value={draft.sort_order} inputMode="numeric"
                 onChange={(e) => setDraft({ ...draft, sort_order: e.target.value })} />
        </label>
      </div>

      <div className="pr-checks">
        <label className="pr-check">
          <input type="checkbox" checked={draft.is_basic}
                 disabled={draft.calculation === 'percent_of_basic'}
                 onChange={(e) => setDraft({ ...draft, is_basic: e.target.checked })} />
          <span>
            This is the basic component
            <span className="pr-field-hint">
              What “% of basic” refers to. One per company.
            </span>
          </span>
        </label>
        <label className="pr-check">
          <input type="checkbox" checked={draft.is_pf_wage}
                 onChange={(e) => setDraft({ ...draft, is_pf_wage: e.target.checked })} />
          <span>
            Counts as PF wages
            <span className="pr-field-hint">Conventionally basic plus DA only.</span>
          </span>
        </label>
        <label className="pr-check">
          <input type="checkbox" checked={draft.is_esi_wage}
                 onChange={(e) => setDraft({ ...draft, is_esi_wage: e.target.checked })} />
          <span>
            Counts as ESI wages
            <span className="pr-field-hint">Broader — most allowances included.</span>
          </span>
        </label>
        <label className="pr-check">
          <input type="checkbox" checked={draft.is_taxable}
                 onChange={(e) => setDraft({ ...draft, is_taxable: e.target.checked })} />
          <span>
            Taxable
            <span className="pr-field-hint">Before exemptions are applied.</span>
          </span>
        </label>
      </div>

      <div className="pr-actions">
        <button className="btn primary"
                disabled={busy || !draft.code.trim() || !draft.name.trim() || rateBad}
                onClick={submit}>
          Add component
        </button>
        <span className="muted">
          {CALCULATIONS.find((c) => c.value === draft.calculation)?.hint}
          {needsRate && rateBps > 0 ? ` Currently ${pct(rateBps)}.` : ''}
        </span>
      </div>
    </section>
  )
}
