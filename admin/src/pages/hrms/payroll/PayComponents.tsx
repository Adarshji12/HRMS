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

import { Fragment, useState, type ReactNode } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type { Calculation, PayComponent } from '../../../lib/types'
import {
  ColumnSettings, FieldSettings, useColumns, useFieldModes,
  type ColumnDef, type FieldDef, type FieldSection,
} from '../../../components/ViewSettings'
import { pct, ruleOf } from './SalaryStructures'
import '../../../styles/payroll.css'

const CALCULATIONS: { value: Calculation; label: string; hint: string }[] = [
  { value: 'fixed', label: 'Fixed amount', hint: 'Stated per employee.' },
  { value: 'percent_of_gross', label: '% of gross', hint: 'Of monthly gross.' },
  { value: 'percent_of_basic', label: '% of basic', hint: 'Of the basic component.' },
  { value: 'balance', label: 'Balance of gross', hint: 'Whatever is left. One only.' },
]

type ComponentCtx = { busy: boolean; run: (action: () => Promise<unknown>) => void }
type ComponentColumn = ColumnDef & {
  td: (component: PayComponent, ctx: ComponentCtx) => ReactNode
  className?: string
  thClass?: string
}

const flag = (key: 'is_pf_wage' | 'is_esi_wage' | 'is_taxable') =>
  (component: PayComponent, ctx: ComponentCtx) => (
    <Toggle on={component[key]} busy={ctx.busy}
            onToggle={() => ctx.run(() =>
              api.patch(`/payroll/components/${component.id}`, { [key]: !component[key] }))} />
  )

const COMPONENT_COLUMNS: ComponentColumn[] = [
  { key: 'code', label: 'Code', locked: true, td: (c) => (
    <>
      <div className="pr-code">{c.code}</div>
      {c.is_basic && <span className="pr-pill">Basic</span>}
    </>
  ) },
  { key: 'name', label: 'Name', td: (c) => (
    <>
      {c.name}
      {c.description && <div className="muted">{c.description}</div>}
    </>
  ) },
  { key: 'how', label: 'How', className: 'muted', td: (c) => ruleOf(c) },
  { key: 'pf', label: 'PF', td: flag('is_pf_wage') },
  { key: 'esi', label: 'ESI', td: flag('is_esi_wage') },
  { key: 'tax', label: 'Tax', td: flag('is_taxable') },
  { key: 'used', label: 'Used by', className: 'num', thClass: 'num', td: (c) => c.usage_count },
  { key: 'active', label: 'Active', td: (c) => (c.is_active ? 'Yes' : <span className="muted">No</span>) },
  { key: 'kind', label: 'Kind', initial: false, td: (c) => c.kind },
  { key: 'sort', label: 'Order', initial: false, className: 'num', thClass: 'num', td: (c) => c.sort_order },
]

const COMPONENT_FIELDS: FieldDef[] = [
  { key: 'code', label: 'Code', section: 'component', fixed: true },
  { key: 'name', label: 'Name', section: 'component', fixed: true },
  { key: 'calculation', label: 'How', section: 'component' },
  { key: 'rate', label: 'Rate %', section: 'component', fixed: true },
  { key: 'sort_order', label: 'Order', section: 'component' },
  { key: 'is_basic', label: 'This is the basic component', section: 'flags', optionalOnly: true },
  { key: 'is_pf_wage', label: 'Counts as PF wages', section: 'flags', optionalOnly: true },
  { key: 'is_esi_wage', label: 'Counts as ESI wages', section: 'flags', optionalOnly: true },
  { key: 'is_taxable', label: 'Taxable', section: 'flags', optionalOnly: true },
]
const COMPONENT_SECTIONS: FieldSection[] = [
  { id: 'component', label: 'Component' },
  { id: 'flags', label: 'Statutory flags' },
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
  const columns = useColumns('pay-components', COMPONENT_COLUMNS)

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
            The lines a payslip can carry, and their statutory flags.
          </p>
        </div>
        <ColumnSettings defs={COMPONENT_COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden}
                        onSave={columns.save} onReset={columns.reset} />
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
        <>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {(columns.visible as ComponentColumn[]).map((col) => (
                  <th key={col.key} className={col.thClass}>{col.label}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {listQ.data.map((component) => (
                <tr key={component.id} className={component.is_active ? '' : 'is-off'}>
                  {(columns.visible as ComponentColumn[]).map((col) => (
                    <td key={col.key} className={col.className}>{col.td(component, { busy, run })}</td>
                  ))}
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
        </div>
        <p className="muted">
            Editing a component changes the next structure built from it, never an existing one.
          </p>
        </>
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
  const fields = useFieldModes('pay-component-form', COMPONENT_FIELDS)
  const fm = fields.mode
  const rq = (key: string) => fm(key) === 'mandatory'
  const missing = fm('sort_order') === 'mandatory' && !draft.sort_order.trim()
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

  const fieldNodes: Record<string, ReactNode> = {
    code: (
      <label className="pr-field">
        <span className="pr-field-label">Code *</span>
        <input value={draft.code} placeholder="BASIC"
               onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
      </label>
    ),
    name: (
      <label className="pr-field pr-field-wide">
        <span className="pr-field-label">Name *</span>
        <input value={draft.name} placeholder="Basic"
               onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </label>
    ),
    calculation: fm('calculation') !== 'hide' && (
      <label className="pr-field">
        <span className="pr-field-label">How{rq('calculation') ? ' *' : ''}</span>
        <select value={draft.calculation}
                onChange={(e) => setDraft({ ...draft, calculation: e.target.value as Calculation })}>
          {CALCULATIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
    ),
    rate: needsRate && (
      <label className="pr-field">
        <span className="pr-field-label">Rate % *</span>
        <input value={draft.rate} inputMode="decimal" placeholder="40"
               className={rateBad ? 'is-bad' : ''}
               onChange={(e) => setDraft({ ...draft, rate: e.target.value })} />
      </label>
    ),
    sort_order: fm('sort_order') !== 'hide' && (
      <label className="pr-field">
        <span className="pr-field-label">Order{rq('sort_order') ? ' *' : ''}</span>
        <input placeholder="10" value={draft.sort_order} inputMode="numeric"
               onChange={(e) => setDraft({ ...draft, sort_order: e.target.value })} />
      </label>
    ),
    is_basic: fm('is_basic') !== 'hide' && (
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
    ),
    is_pf_wage: fm('is_pf_wage') !== 'hide' && (
      <label className="pr-check">
        <input type="checkbox" checked={draft.is_pf_wage}
               onChange={(e) => setDraft({ ...draft, is_pf_wage: e.target.checked })} />
        <span>
          Counts as PF wages
          <span className="pr-field-hint">Conventionally basic plus DA only.</span>
        </span>
      </label>
    ),
    is_esi_wage: fm('is_esi_wage') !== 'hide' && (
      <label className="pr-check">
        <input type="checkbox" checked={draft.is_esi_wage}
               onChange={(e) => setDraft({ ...draft, is_esi_wage: e.target.checked })} />
        <span>
          Counts as ESI wages
          <span className="pr-field-hint">Broader — most allowances included.</span>
        </span>
      </label>
    ),
    is_taxable: fm('is_taxable') !== 'hide' && (
      <label className="pr-check">
        <input type="checkbox" checked={draft.is_taxable}
               onChange={(e) => setDraft({ ...draft, is_taxable: e.target.checked })} />
        <span>
          Taxable
          <span className="pr-field-hint">Before exemptions are applied.</span>
        </span>
      </label>
    ),
  }
  const fieldsOf = (section: string) =>
    fields.orderOf(section).map((key) => <Fragment key={key}>{fieldNodes[key]}</Fragment>)

  return (
    <section className="card pr-form">
      <h2 className="card-title">Add a component</h2>
      <div className="lf-settings">
        <FieldSettings defs={COMPONENT_FIELDS} sections={COMPONENT_SECTIONS} modes={fields.modes} order={fields.order}
                       onSave={fields.save} onReset={fields.reset} />
      </div>
      <div className="pr-row">
        {fieldsOf('component')}
      </div>

      <div className="pr-checks">
        {fieldsOf('flags')}
      </div>

      <div className="pr-actions">
        <button className="btn primary"
                disabled={busy || !draft.code.trim() || !draft.name.trim() || rateBad || missing}
                onClick={submit}>
          Add component
        </button>
        <span className="muted">
          {missing ? 'Fill in the fields marked *. ' : ''}
          {CALCULATIONS.find((c) => c.value === draft.calculation)?.hint}
          {needsRate && rateBps > 0 ? ` Currently ${pct(rateBps)}.` : ''}
        </span>
      </div>
    </section>
  )
}
