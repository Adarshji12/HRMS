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

import { useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { money, toPaise } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type { ExpenseCategory } from '../../../lib/types'
import '../../../styles/expenses.css'

export default function ExpenseSettings() {
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
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Category</th><th>Receipt</th><th className="num">Cap per item</th>
                <th className="num">Claimed on</th><th>Active</th><th />
              </tr>
            </thead>
            <tbody>
              {listQ.data.map((category) => (
                <tr key={category.id}>
                  <td>
                    <div className="ex-title">{category.name}</div>
                    {category.description && (
                      <div className="muted">{category.description}</div>
                    )}
                  </td>
                  <td>
                    {category.requires_receipt
                      ? 'Required'
                      : <span className="muted">Optional</span>}
                  </td>
                  <td className="num">
                    {category.max_amount === null
                      ? <span className="muted">No cap</span>
                      : money(category.max_amount)}
                  </td>
                  <td className="num">{category.line_count}</td>
                  <td>
                    {category.is_active
                      ? <span className="ex-ok">Yes</span>
                      : <span className="muted">No</span>}
                  </td>
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
          <p className="muted">
            Categories are deactivated rather than deleted — a claim line without
            a category cannot be reported on, so a category that has ever been
            claimed against stays for the record.
          </p>
        </div>
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

  const capPaise = cap.trim() ? toPaise(cap) : null
  const capInvalid = Boolean(cap.trim()) && (capPaise === null || capPaise <= 0)

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

  return (
    <section className="card ex-newclaim">
      <h2 className="card-title">Add a category</h2>
      <div className="ex-row">
        <input placeholder="Name — e.g. Travel" value={name}
               onChange={(e) => setName(e.target.value)} />
        <input placeholder="Description (optional)" value={description}
               onChange={(e) => setDescription(e.target.value)} />
        <input placeholder="Cap per item — blank for none" value={cap}
               inputMode="decimal" className={capInvalid ? 'is-bad' : ''}
               onChange={(e) => setCap(e.target.value)} />
        <label className="ex-check">
          <input type="checkbox" checked={requiresReceipt}
                 onChange={(e) => setRequiresReceipt(e.target.checked)} />
          <span>Receipt required</span>
        </label>
        <button className="btn primary" disabled={busy || !name.trim() || capInvalid}
                onClick={submit}>
          Add
        </button>
      </div>
      <p className="muted">
        Leave the cap blank for no ceiling. Zero is refused — a category capped at
        zero would refuse every claim in it.
      </p>
    </section>
  )
}
