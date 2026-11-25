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

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { money, toPaise } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type {
  PayComponent,
  SalaryStructure,
  StructurePreview,
} from '../../../lib/types'
import { FieldSettings, useFieldModes, type FieldDef, type FieldSection } from '../../../components/ViewSettings'
import { Dialog } from '../../crm/parts'
import type { RichPreview, SalaryTemplate } from './SalarySetup'
import '../../../styles/payroll.css'

// Server requires the gross and the effective date; the reason is optional.
const REVISION_FIELDS: FieldDef[] = [
  { key: 'gross', label: 'Monthly gross', section: 'revision', fixed: true },
  { key: 'effective', label: 'Effective from', section: 'revision', fixed: true },
  { key: 'reason', label: 'Reason', section: 'revision' },
]
const REVISION_SECTIONS: FieldSection[] = [{ id: 'revision', label: 'Revision' }]

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

interface RosterRow {
  user_id: string; full_name: string; employee_code: string | null; designation: string | null
  department: string | null; gross_monthly: number | null; effective_from: string | null
}

export default function SalaryStructures() {
  const rosterQ = useQuery<RosterRow[]>('payroll-roster', () => api.get<RosterRow[]>('/payroll/roster'))
  const componentsQ = useQuery<PayComponent[]>('pay-components-active', () =>
    api.get<PayComponent[]>('/payroll/components?active_only=true'),
  )
  const [search, setSearch] = useState('')
  const [setting, setSetting] = useState<RosterRow | null>(null)
  const [history, setHistory] = useState<RosterRow | null>(null)
  const [error, setError] = useState<string | null>(null)

  const rows = rosterQ.data ?? []
  const q = search.trim().toLowerCase()
  const shown = rows.filter((r) => !q || r.full_name.toLowerCase().includes(q) || (r.employee_code ?? '').toLowerCase().includes(q))
  const onSalary = rows.filter((r) => r.gross_monthly != null).length

  if (history) {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <button className="btn small" onClick={() => { setHistory(null); rosterQ.reload() }}>← Employee salaries</button>
            <h1>{history.full_name}</h1>
            <p className="muted">Salary history. A change is a new revision, effective from a date.</p>
          </div>
        </header>
        {error && <ErrorNote>{error}</ErrorNote>}
        <Person userId={history.user_id} onChanged={() => rosterQ.reload()} onError={setError} />
      </div>
    )
  }

  return (
    <div className="page">
      {error && <ErrorNote>{error}</ErrorNote>}
      <section className="card">
        <div className="card-head" style={{ justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h2 className="card-title">Employee Salaries</h2>
            <p className="muted-sm">{rows.length} employees · {onSalary} on a salary</p>
          </div>
          <input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 260 }} />
        </div>
        {rosterQ.error ? <ErrorNote>{rosterQ.error}</ErrorNote> : rosterQ.loading && !rosterQ.data ? <Loading /> : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Employee</th><th>Department</th><th className="num">Monthly CTC</th><th className="num">Annual</th><th>Effective</th><th /></tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.user_id}>
                    <td>
                      <b>{r.full_name}</b>
                      <div className="muted-sm">{[r.employee_code, r.designation].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td>{r.department ?? '—'}</td>
                    <td className="num">{r.gross_monthly != null ? money(r.gross_monthly) : <span style={{ color: '#d97706' }}>Not set</span>}</td>
                    <td className="num">{r.gross_monthly != null ? money(r.gross_monthly * 12) : '—'}</td>
                    <td>{r.effective_from ?? '—'}</td>
                    <td className="row-actions">
                      {r.gross_monthly != null && <button className="btn small" onClick={() => setHistory(r)}>History</button>}{' '}
                      <button className="btn small" onClick={() => setSetting(r)}>{r.gross_monthly != null ? 'Revise' : 'Set'}</button>
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && <tr><td colSpan={6}><Empty>Nobody matches that search.</Empty></td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {setting && (
        <SalaryDialog person={setting} components={componentsQ.data ?? []}
                      onClose={() => setSetting(null)} onSaved={() => { setSetting(null); rosterQ.reload() }} />
      )}
    </div>
  )
}

/** Set or revise one person's pay: CTC, fixed amounts, and a live monthly breakdown beside it. */
function SalaryDialog({ person, components, onClose, onSaved }: {
  person: RosterRow; components: PayComponent[]; onClose: () => void; onSaved: () => void
}) {
  const [gross, setGross] = useState(person.gross_monthly != null ? String(person.gross_monthly / 100) : '')
  const [effective, setEffective] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().slice(0, 10)
  })
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [remarks, setRemarks] = useState('')
  const templatesQ = useQuery<SalaryTemplate[]>('salary-templates', () => api.get<SalaryTemplate[]>('/payroll/templates'))
  const templates = (templatesQ.data ?? []).filter((t) => t.is_active)
  const [templateId, setTemplateId] = useState<string | null>(null)
  const chosenId = templateId ?? templates.find((t) => t.is_default)?.id ?? ''
  const chosen = templates.find((t) => t.id === chosenId)
  const [preview, setPreview] = useState<RichPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState<string | null>(null)
  const grossPaise = toPaise(gross)
  const earnings = useMemo(
    () => components.filter((c) => c.kind === 'earning' && (!chosen || chosen.component_ids.includes(c.id))),
    [components, chosen],
  )
  const fixed = earnings.filter((c) => (chosen?.rules?.[c.id]?.calculation ?? c.calculation) === 'fixed')

  const lines = useCallback(() => earnings.map((c) => ({
    component_id: c.id,
    amount: (chosen?.rules?.[c.id]?.calculation ?? c.calculation) === 'fixed' ? toPaise(amounts[c.id] ?? '') : null,
    ...(chosen?.rules?.[c.id]?.calculation ? { calculation: chosen.rules[c.id].calculation, rate_bps: chosen.rules[c.id].rate_bps } : {}),
  })), [earnings, amounts, chosen])

  useEffect(() => {
    if (!grossPaise) { setPreview(null); return }
    const t = setTimeout(async () => {
      try {
        setPreview(await api.post<RichPreview>('/payroll/preview', { gross_monthly: grossPaise, components: lines() }))
        setFail(null)
      } catch (caught) { setPreview(null); setFail((caught as Error).message) }
    }, 350)
    return () => clearTimeout(t)
  }, [grossPaise, lines])

  async function save() {
    setBusy(true); setFail(null)
    try {
      await api.post(`/payroll/${person.user_id}`, {
        effective_from: effective, gross_monthly: grossPaise, components: lines(), reason: remarks.trim() || null,
      })
      onSaved()
    } catch (caught) { setFail((caught as Error).message) } finally { setBusy(false) }
  }

  return (
    <Dialog title={`Set salary — ${person.full_name}`} wide onClose={onClose}
            footer={<>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={!grossPaise || !preview || busy || !effective} onClick={save}>
                {busy ? 'Saving…' : 'Save salary'}
              </button>
            </>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) minmax(240px,1fr)', gap: 20, padding: '8px 24px 20px', flex: 1, minHeight: 0, overflowY: 'auto', alignContent: 'start' }}>
        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            <label className="pr-field"><span className="pr-field-label">Monthly CTC (₹)</span>
              <input type="number" data-spin min={0} step="any" placeholder="50000" value={gross} onChange={(e) => setGross(e.target.value)} />
            </label>
            <label className="pr-field"><span className="pr-field-label">Structure</span>
              <select value={chosenId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">— Every active</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label className="pr-field"><span className="pr-field-label">Effective from</span>
              <input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} />
              <span className="pr-field-hint">A revision starts a new row</span>
            </label>
          </div>
          {fixed.length > 0 && (
            <fieldset style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, margin: 0 }}>
              <legend className="pr-field-label">FIXED AMOUNTS FOR THIS PERSON</legend>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                {fixed.map((c) => (
                  <label key={c.id} className="pr-field"><span className="pr-field-label">{c.name} (₹)</span>
                    <input inputMode="decimal" value={amounts[c.id] ?? ''} onChange={(e) => setAmounts((p) => ({ ...p, [c.id]: e.target.value }))} />
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <label className="pr-field"><span className="pr-field-label">Remarks</span>
            <input value={remarks} placeholder="Annual revision, promotion, correction" onChange={(e) => setRemarks(e.target.value)} />
          </label>
          {fail && <ErrorNote>{fail}</ErrorNote>}
        </div>
        <aside style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 16, background: 'var(--surface-2)', alignSelf: 'start' }}>
          <div className="pr-field-label" style={{ marginBottom: 10 }}>MONTHLY BREAKDOWN</div>
          {!preview ? <p className="muted-sm">Enter a CTC to see the breakdown.</p> : (
            <table className="table" style={{ background: 'transparent' }}>
              <tbody>
                {preview.components.map((l) => (
                  <tr key={l.component_id}><td>{l.code}<div className="muted-sm">{ruleOf(l)}</div></td><td className="num">{money(l.amount)}</td></tr>
                ))}
                <tr className="pr-total-row"><td>Gross</td><td className="num">{money(preview.gross_monthly)}</td></tr>
                {preview.deductions.map((l) => <tr key={l.code}><td>{l.name}</td><td className="num" style={{ color: '#e5484d' }}>-{money(l.amount)}</td></tr>)}
                <tr className="pr-total-row"><td>Net pay</td><td className="num" style={{ color: '#0f9d6a' }}>{money(preview.net_monthly)}</td></tr>
              </tbody>
            </table>
          )}
          {preview?.notes.map((n, i) => <p key={i} className="muted-sm">{n}</p>)}
        </aside>
      </div>
    </Dialog>
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
  const fields = useFieldModes('salary-revision-form', REVISION_FIELDS)
  const fm = fields.mode
  const missing = fm('reason') === 'mandatory' && !reason.trim()
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

  const fieldNodes: Record<string, ReactNode> = {
    gross: (
      <label className="pr-field">
        <span className="pr-field-label">Monthly gross <span className="lf-req">*</span></span>
        <input value={gross} type="number" data-spin min={0} step="any" placeholder="50000"
               className={gross && grossPaise === null ? 'is-bad' : ''}
               onChange={(e) => { setGross(e.target.value); setPreview(null) }} />
      </label>
    ),
    effective: (
      <label className="pr-field">
        <span className="pr-field-label">Effective from <span className="lf-req">*</span></span>
        <input type="date" value={effective}
               onChange={(e) => setEffective(e.target.value)} />
      </label>
    ),
    reason: fm('reason') !== 'hide' && (
      <label className="pr-field pr-field-wide">
        <span className="pr-field-label">Reason{fm('reason') === 'mandatory' ? <span className="lf-req"> *</span> : null}</span>
        <input value={reason} placeholder="Annual revision, promotion, correction"
               onChange={(e) => setReason(e.target.value)} />
      </label>
    ),
  }

  return (
    <section className="card pr-form">
      <h2 className="card-title">New revision</h2>
      <div className="lf-settings">
        <FieldSettings defs={REVISION_FIELDS} sections={REVISION_SECTIONS} modes={fields.modes} order={fields.order}
                       onSave={fields.save} onReset={fields.reset} />
      </div>
      <div className="pr-row">
        {fields.orderOf('revision').map((key) => <Fragment key={key}>{fieldNodes[key]}</Fragment>)}
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
                disabled={!preview || !grossPaise || busy || !effective || missing}
                onClick={save}>
          Save revision
        </button>
        <span className="muted">
          {missing ? <>Fill in the fields marked <b className="lf-req">*</b>. </> : ''}
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
