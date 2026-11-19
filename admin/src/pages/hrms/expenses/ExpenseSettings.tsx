/* Expense categories — what the company reimburses, and the rules per category.

   Two settings per category, and both are per-category rather than
   company-wide for the same reason: a taxi fare and a laptop purchase do not
   warrant the same evidence or the same ceiling, and a single global switch gets
   set for the strictest case and then ignored for everything else.

   `max_amount` has no "unlimited" input because *empty* is unlimited. Zero is
   refused by the server — a category capped at zero refuses every claim in it,
   which is never what anybody meant to configure.

   A category in use cannot be deleted; it is deactivated instead. `line_count`
   arrives on the row so this screen can say so before the attempt fails on a
   foreign key. */

import { Fragment, useState, type ReactNode } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { money, toPaise } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type { ExpenseCategory } from '../../../lib/types'
import {
  ColumnSettings, FieldSettings, useColumns, useFieldModes,
  type ColumnDef, type FieldDef, type FieldSection,
} from '../../../components/ViewSettings'
import '../../../styles/expenses.css'

type CategoryColumn = ColumnDef & { td: (row: ExpenseCategory) => ReactNode; className?: string; thClass?: string }

const CATEGORY_COLUMNS: CategoryColumn[] = [
  { key: 'name', label: 'Category', locked: true, td: (category) => (
    <>
      <div className="ex-title">{category.name}</div>
      {category.description && <div className="muted">{category.description}</div>}
    </>
  ) },
  { key: 'receipt', label: 'Receipt', td: (category) => (
    category.requires_receipt ? 'Required' : <span className="muted">Optional</span>
  ) },
  { key: 'cap', label: 'Cap per item', className: 'num', thClass: 'num', td: (category) => (
    category.max_amount === null ? <span className="muted">No cap</span> : money(category.max_amount)
  ) },
  { key: 'claimed', label: 'Claimed on', className: 'num', thClass: 'num', td: (category) => category.line_count },
  { key: 'active', label: 'Active', td: (category) => (
    category.is_active ? <span className="ex-ok">Yes</span> : <span className="muted">No</span>
  ) },
  { key: 'description', label: 'Description', initial: false, td: (category) => category.description || <span className="muted">—</span> },
]

const CATEGORY_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Name', section: 'category', fixed: true },
  { key: 'description', label: 'Description', section: 'category' },
  { key: 'cap', label: 'Cap per item', section: 'category' },
  { key: 'receipt', label: 'Receipt required', section: 'category', optionalOnly: true },
]
const CATEGORY_SECTIONS: FieldSection[] = [{ id: 'category', label: 'Category' }]

export default function ExpenseSettings() {
  const columns = useColumns('expense-categories', CATEGORY_COLUMNS)
  const listQ = useQuery<ExpenseCategory[]>('expense-categories-all', () =>
    api.get<ExpenseCategory[]>('/expenses/categories'),
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
          <h1>Expense settings</h1>
          <p className="muted">
            Categories employees can claim against, and the rules for each.
          </p>
        </div>
        <ColumnSettings defs={CATEGORY_COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden}
                        onSave={columns.save} onReset={columns.reset} />
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      <NewCategory busy={busy} onCreate={(body) => run(() =>
        api.post('/expenses/categories', body))} />

      {listQ.loading ? (
        <Loading />
      ) : listQ.error ? (
        <ErrorNote>{listQ.error}</ErrorNote>
      ) : !listQ.data?.length ? (
        <Empty>No categories yet. Add the first one above.</Empty>
      ) : (
        <>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {columns.visible.map((col) => (
                  <th key={col.key} className={(col as CategoryColumn).thClass}>{col.label}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {listQ.data.map((category) => (
                <tr key={category.id}>
                  {columns.visible.map((col) => (
                    <td key={col.key} className={(col as CategoryColumn).className}>
                      {(col as CategoryColumn).td(category)}
                    </td>
                  ))}
                  <td className="row-actions">
                    <button className="btn small" disabled={busy}
                            onClick={() => run(() =>
                              api.patch(`/expenses/categories/${category.id}`, {
                                requires_receipt: !category.requires_receipt,
                              }))}>
                      {category.requires_receipt ? 'Receipt optional' : 'Require receipt'}
                    </button>
                    <button className="btn small" disabled={busy}
                            onClick={() => run(() =>
                              api.patch(`/expenses/categories/${category.id}`, {
                                is_active: !category.is_active,
                              }))}>
                      {category.is_active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted">
          Categories are deactivated rather than deleted — a claim line without
          a category cannot be reported on, so a category that has ever been
          claimed against stays for the record.
        </p>
        </>
      )}
    </div>
  )
}

function NewCategory({
  busy,
  onCreate,
}: {
  busy: boolean
  onCreate: (body: Record<string, unknown>) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [requiresReceipt, setRequiresReceipt] = useState(true)
  const [cap, setCap] = useState('')
  const fields = useFieldModes('expense-category-form', CATEGORY_FIELDS)
  const fm = fields.mode
  const rq = (key: string) => fm(key) === 'mandatory'

  const capPaise = cap.trim() ? toPaise(cap) : null
  const capInvalid = Boolean(cap.trim()) && (capPaise === null || capPaise <= 0)

  const missing =
    (rq('description') && !description.trim()) || (rq('cap') && !cap.trim())

  function submit() {
    onCreate({
      name: name.trim(),
      description: description.trim() || null,
      requires_receipt: requiresReceipt,
      max_amount: capPaise && capPaise > 0 ? capPaise : null,
    })
    setName('')
    setDescription('')
    setCap('')
  }

  const fieldNodes: Record<string, ReactNode> = {
    name: (
      <input placeholder="Name — e.g. Travel" value={name}
             onChange={(e) => setName(e.target.value)} />
    ),
    description: fm('description') !== 'hide' && (
      <input placeholder={rq('description') ? 'Description *' : 'Description (optional)'} value={description}
             onChange={(e) => setDescription(e.target.value)} />
    ),
    cap: fm('cap') !== 'hide' && (
      <input placeholder={rq('cap') ? 'Cap per item *' : 'Cap per item — blank for none'} value={cap}
             inputMode="decimal" className={capInvalid ? 'is-bad' : ''}
             onChange={(e) => setCap(e.target.value)} />
    ),
    receipt: fm('receipt') !== 'hide' && (
      <label className="ex-check">
        <input type="checkbox" checked={requiresReceipt}
               onChange={(e) => setRequiresReceipt(e.target.checked)} />
        <span>Receipt required</span>
      </label>
    ),
  }

  return (
    <section className="card ex-newclaim">
      <h2 className="card-title" style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        Add a category
        <FieldSettings defs={CATEGORY_FIELDS} sections={CATEGORY_SECTIONS} modes={fields.modes} order={fields.order}
                       onSave={fields.save} onReset={fields.reset} title="Category fields" />
      </h2>
      <div className="ex-row">
        {fields.orderOf('category').map((key) => <Fragment key={key}>{fieldNodes[key]}</Fragment>)}
        <button className="btn primary" disabled={busy || !name.trim() || capInvalid || missing}
                onClick={submit}>
          Add
        </button>
      </div>
      <p className="muted">
        Leave the cap blank for no ceiling. Zero is refused — a category capped at
        zero would refuse every claim in it.
        {missing && ' Fill in the fields marked *.'}
      </p>
    </section>
  )
}
