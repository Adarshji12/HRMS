/* Salary structures — one person's pay, and the history of it.

   Four server truths this file is built around:

   1. **A revision is a new row, never an edit.** There is no edit control on an
      existing structure — not a disabled one, none at all — because the API has
      no such route. The history below the form is the point of the screen.

   2. **The server resolves the components.** This file never computes an
      amount. `Preview` posts the choices and renders what comes back, so the
      figures an administrator approves are the same ones that get stored.

   3. **Percentages have no amount input.** Only a `fixed` component takes one.
      An input beside "40% of basic" would let somebody type a number that
      contradicts the rule printed next to it.

   4. **Amounts are integer paise, monthly.** `money()` formats at the very edge
      and `toPaise()` parses at the other; the annual figure is presented, never
      entered. */

import { useCallback, useMemo, useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { money, toPaise } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type {
  DirectoryEntry,
  PayComponent,
  SalaryStructure,
  StructurePreview,
  UncoveredEmployee,
} from '../../../lib/types'
import '../../../styles/payroll.css'

/** Basis points as a percentage: 4000 → "40%". */
export function pct(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`
}

export function ruleOf(component: { calculation: string; rate_bps: number }): string {
  switch (component.calculation) {
    case 'percent_of_basic': return `${pct(component.rate_bps)} of basic`
    case 'percent_of_gross': return `${pct(component.rate_bps)} of gross`
    case 'balance': return 'balance of gross'
    default: return 'fixed amount'
  }
}

export default function SalaryStructures() {
  const peopleQ = useQuery<DirectoryEntry[]>('payroll-directory', () =>
    api.get<DirectoryEntry[]>('/people/directory'),
  )
  const uncoveredQ = useQuery<UncoveredEmployee[]>('payroll-uncovered', () =>
    api.get<UncoveredEmployee[]>('/payroll/uncovered'),
  )
  const [userId, setUserId] = useState('')
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Salary structures</h1>
          <p className="muted">
            One person at a time. A change is a new revision effective from a
            date — the old one stays, because payroll has to be able to
            reproduce what it ran.
          </p>
        </div>
        <select value={userId} onChange={(event) => setUserId(event.target.value)}
                aria-label="Employee">
          <option value="">Choose an employee…</option>
          {(peopleQ.data ?? []).map((person) => (
            <option key={person.user_id} value={person.user_id}>
              {person.full_name}
              {person.employee_code ? ` · ${person.employee_code}` : ''}
            </option>
          ))}
        </select>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      {!userId ? (
        <Uncovered
          rows={uncoveredQ.data ?? []}
          loading={uncoveredQ.loading}
          onPick={setUserId}
        />
      ) : (
        <Person
          userId={userId}
          onChanged={() => uncoveredQ.reload()}
          onError={setError}
        />
      )}
    </div>
  )
}

/** The setup view: who has no salary on file at all. */
function Uncovered({
  rows,
  loading,
  onPick,
}: {
  rows: UncoveredEmployee[]
  loading: boolean
  onPick: (id: string) => void
}) {
  if (loading) return <Loading />
  if (!rows.length) {
    return <Empty>Everybody active has a salary structure. Pick a name above to review one.</Empty>
  }
  return (
    <section className="card">
      <h2 className="card-title">No salary on file</h2>
      <p className="muted">
        These active employees have no structure at all. Deliberately no amounts
        here — it is a list of gaps, not of pay.
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Code</th><th>Joined</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.user_id}>
                <td>
                  <div className="pr-title">{row.full_name}</div>
                  <div className="muted">{row.email}</div>
                </td>
                <td>{row.employee_code ?? '—'}</td>
                <td>{row.joined_on ?? '—'}</td>
                <td className="row-actions">
                  <button className="btn small" onClick={() => onPick(row.user_id)}>
                    Set salary
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Person({
  userId,
  onChanged,
  onError,
}: {
  userId: string
  onChanged: () => void
  onError: (message: string) => void
}) {
  const historyQ = useQuery<SalaryStructure[]>(`payroll-${userId}`, () =>
    api.get<SalaryStructure[]>(`/payroll/${userId}`),
  )
  const componentsQ = useQuery<PayComponent[]>('pay-components-active', () =>
    api.get<PayComponent[]>('/payroll/components?active_only=true'),
  )
  const [adding, setAdding] = useState(false)

  const reload = useCallback(() => {
    historyQ.reload()
    onChanged()
  }, [historyQ, onChanged])

  if (historyQ.loading) return <Loading />
  if (historyQ.error) return <ErrorNote>{historyQ.error}</ErrorNote>

  const history = historyQ.data ?? []
  const current = history.find((row) => row.is_current)

  return (
    <>
      {current && (
        <div className="pr-tiles">
          <Tile label="Monthly gross" value={money(current.gross_monthly)}
                meta={`from ${current.effective_from}`} />
          <Tile label="Annual" value={money(current.annual_gross)}
                meta="twelve months" />
          <Tile label="PF wages" value={money(current.pf_wage_monthly)}
                meta="monthly, per component flags" />
          <Tile label="Taxable" value={money(current.taxable_monthly)}
                meta="monthly, before exemptions" />
        </div>
      )}

      <div className="pr-head-row">
        <h2 className="card-title">
          {history.length ? 'Revisions' : 'No salary set yet'}
        </h2>
        <button className="btn primary" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Close' : history.length ? 'New revision' : 'Set salary'}
        </button>
      </div>

      {adding && (
        <NewRevision
          userId={userId}
          components={componentsQ.data ?? []}
          onDone={() => { setAdding(false); reload() }}
          onError={onError}
        />
      )}

      {!history.length ? (
        <Empty>Nothing on file for this person.</Empty>
      ) : (
        history.map((row) => (
          <Revision key={row.id} structure={row} onChanged={reload} onError={onError} />
        ))
      )}
    </>
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

function Revision({
  structure,
  onChanged,
  onError,
}: {
  structure: SalaryStructure
  onChanged: () => void
  onError: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)

  async function remove() {
    setBusy(true)
    try {
      await api.del(`/payroll/structures/${structure.id}`)
      onChanged()
    } catch (caught) {
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={`card pr-revision${structure.is_current ? ' is-current' : ''}`}>
      <div className="pr-revision-head">
        <div>
          <div className="pr-title">
            {money(structure.gross_monthly)} a month
            {structure.is_current && <span className="pr-pill">Current</span>}
          </div>
          <div className="muted">
            {structure.effective_from} — {structure.effective_to ?? 'ongoing'}
            {structure.reason ? ` · ${structure.reason}` : ''}
            {structure.created_by_name ? ` · set by ${structure.created_by_name}` : ''}
          </div>
        </div>
        {/* No edit control anywhere: the API has no route for one, because a
            revision that could be edited is a pay run that cannot be
            reproduced. Deleting exists only while no pay run has used it. */}
        <button className="btn small danger" disabled={busy} onClick={remove}>
          Delete revision
        </button>
      </div>

      <div className="table-wrap">
        <table className="table pr-components">
          <thead>
            <tr>
              <th>Component</th><th>How</th><th>PF</th><th>ESI</th><th>Tax</th>
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
                <td>{line.is_pf_wage ? <span className="pr-yes">✓</span> : '—'}</td>
                <td>{line.is_esi_wage ? <span className="pr-yes">✓</span> : '—'}</td>
                <td>{line.is_taxable ? <span className="pr-yes">✓</span> : '—'}</td>
                <td className="num">{money(line.amount)}</td>
                <td className="num muted">{money(line.amount * 12)}</td>
              </tr>
            ))}
            <tr className="pr-total-row">
              <td colSpan={5}>Gross</td>
              <td className="num">{money(structure.gross_monthly)}</td>
              <td className="num">{money(structure.annual_gross)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}

function NewRevision({
  userId,
  components,
  onDone,
  onError,
}: {
  userId: string
  components: PayComponent[]
  onDone: () => void
  onError: (message: string) => void
}) {
  const [gross, setGross] = useState('')
  const [effective, setEffective] = useState(() => {
    // The first of next month: a salary change almost always takes effect at a
    // month boundary, and defaulting to today makes a part-month nobody wanted.
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().slice(0, 10)
  })
  const [reason, setReason] = useState('')
  const [chosen, setChosen] = useState<Record<string, string>>(() =>
    Object.fromEntries(components.map((c) => [c.id, ''])),
  )
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(components.map((c) => c.id)),
  )
  const [preview, setPreview] = useState<StructurePreview | null>(null)
  const [busy, setBusy] = useState(false)

  const grossPaise = toPaise(gross)
  const earnings = useMemo(
    () => components.filter((c) => c.kind === 'earning'),
    [components],
  )

  function lines() {
    return earnings
      .filter((c) => selected.has(c.id))
      .map((c) => ({
        component_id: c.id,
        // Only a fixed component carries an amount; the rest are computed.
        amount: c.calculation === 'fixed' ? toPaise(chosen[c.id] ?? '') : null,
      }))
  }

  async function runPreview() {
    if (!grossPaise) return
    setBusy(true)
    try {
      setPreview(
        await api.post<StructurePreview>('/payroll/preview', {
          gross_monthly: grossPaise,
          components: lines(),
        }),
      )
    } catch (caught) {
      setPreview(null)
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    setBusy(true)
    try {
      await api.post(`/payroll/${userId}`, {
        effective_from: effective,
        gross_monthly: grossPaise,
        components: lines(),
        reason: reason.trim() || null,
      })
      onDone()
    } catch (caught) {
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!earnings.length) {
    return (
      <Empty>
        No pay components are set up. Define them under Pay components first — a
        structure is made of them.
      </Empty>
    )
  }

  return (
    <section className="card pr-form">
      <h2 className="card-title">New revision</h2>
      <div className="pr-row">
        <label className="pr-field">
          <span className="pr-field-label">Monthly gross</span>
          <input value={gross} inputMode="decimal" placeholder="50000"
                 className={gross && grossPaise === null ? 'is-bad' : ''}
                 onChange={(e) => { setGross(e.target.value); setPreview(null) }} />
        </label>
        <label className="pr-field">
          <span className="pr-field-label">Effective from</span>
          <input type="date" value={effective}
                 onChange={(e) => setEffective(e.target.value)} />
        </label>
        <label className="pr-field pr-field-wide">
          <span className="pr-field-label">Reason</span>
          <input value={reason} placeholder="Annual revision, promotion, correction"
                 onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>

      <table className="table pr-picker">
        <thead>
          <tr><th /><th>Component</th><th>How</th><th className="num">Amount</th></tr>
        </thead>
        <tbody>
          {earnings.map((component) => (
            <tr key={component.id}>
              <td>
                <input type="checkbox" checked={selected.has(component.id)}
                       aria-label={`Include ${component.name}`}
                       onChange={(e) => {
                         setPreview(null)
                         setSelected((prev) => {
                           const next = new Set(prev)
                           if (e.target.checked) next.add(component.id)
                           else next.delete(component.id)
                           return next
                         })
                       }} />
              </td>
              <td>
                <div className="pr-code">{component.code}</div>
                <div className="muted">{component.name}</div>
              </td>
              <td className="muted">{ruleOf(component)}</td>
              <td className="num">
                {component.calculation === 'fixed' ? (
                  <input className="pr-amount" inputMode="decimal" placeholder="0.00"
                         value={chosen[component.id] ?? ''}
                         disabled={!selected.has(component.id)}
                         onChange={(e) => {
                           setPreview(null)
                           setChosen((prev) => ({ ...prev, [component.id]: e.target.value }))
                         }} />
                ) : (
                  /* No input: an amount box beside "40% of basic" invites a
                     number that contradicts the rule next to it. */
                  <span className="muted">computed</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pr-actions">
        <button className="btn" disabled={!grossPaise || busy} onClick={runPreview}>
          Preview
        </button>
        <button className="btn primary"
                disabled={!preview || !grossPaise || busy || !effective}
                onClick={save}>
          Save revision
        </button>
        <span className="muted">
          Preview first — it is the server resolving these, so what you see is
          what gets stored.
        </span>
      </div>

      {preview && (
        <div className="table-wrap pr-preview">
          <table className="table">
            <thead>
              <tr><th>Component</th><th>How</th><th className="num">Monthly</th></tr>
            </thead>
            <tbody>
              {preview.components.map((line) => (
                <tr key={line.component_id}>
                  <td>{line.code}</td>
                  <td className="muted">{ruleOf(line)}</td>
                  <td className="num">{money(line.amount)}</td>
                </tr>
              ))}
              <tr className="pr-total-row">
                <td colSpan={2}>Gross</td>
                <td className="num">{money(preview.gross_monthly)}</td>
              </tr>
            </tbody>
          </table>
          <p className="muted">
            PF wages {money(preview.pf_wage_monthly)} · ESI wages{' '}
            {money(preview.esi_wage_monthly)} · taxable{' '}
            {money(preview.taxable_monthly)} — these are what statutory
            computation will read.
          </p>
        </div>
      )}
    </section>
  )
}
