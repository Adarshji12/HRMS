/* Approval rules — one row per request type, each opening into its levels.
 *
 * Each request type follows the levels set here, in order. A level says which role approves;
 * who that turns out to be is read from the employee's own Reporting Manager and Head of
 * Department. The switches on a level (Mandatory, Auto skip, Final, Active) and on a flow
 * (Sequential approval, A rejection ends it, Notify the approver) change how the engine runs.
 *
 * Requests already under way keep the levels they were routed with; changes apply to the next
 * ones. Rules by amount or department, and escalation, are not shown here (WorkflowSetup still
 * holds them, and the engine still applies any that are already configured).
 */

import { useEffect, useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { ErrorNote, Loading } from '../../../components/ui'
import { IconPlus } from '../../../components/Icons'

interface LevelRow {
  id?: string
  reviewer_rule: string
  reviewer_user_id: string | null
  auto_forward_days: number
  escalate_after_days: number
  escalate_to_user_id: string | null
  is_mandatory: boolean
  auto_skip: boolean
  is_final: boolean
  is_active: boolean
}

interface Flow {
  kind: string
  is_enabled: boolean
  sequential: boolean
  reject_ends: boolean
  notify_approver: boolean
}

interface Overview {
  flow: Flow
  levels: LevelRow[]
}

interface Person { user_id: string; full_name: string }

const KIND: Record<string, string> = {
  leave: 'Leave Request',
  timesheet: 'Timesheet',
  regularization: 'Attendance Regularization',
  expense: 'Expense Claim',
  loan: 'Loan & Advance',
  performance: 'Performance Review',
  purchase_requisition: 'Purchase Requisition',
  purchase_order: 'Purchase Order',
  stock_adjustment: 'Stock Adjustment',
  sales_order: 'Sales Order',
  credit_note: 'Credit Note',
  sales_incentive: 'Sales Incentive',
}

const APPROVERS: Array<{ value: string; label: string; short: string }> = [
  { value: 'reporting_manager', label: 'Reporting Manager', short: 'RM' },
  { value: 'skip_level_manager', label: 'Manager’s Manager', short: 'RM’s RM' },
  { value: 'department_head', label: 'Head of Department', short: 'HOD' },
  { value: 'named_user', label: 'A specific person', short: 'Person' },
  { value: 'capability', label: 'Anyone with the permission', short: 'Approver' },
]

const MAX_LEVELS = 5

const blank = (): LevelRow => ({
  reviewer_rule: 'reporting_manager', reviewer_user_id: null, auto_forward_days: 0, escalate_after_days: 0,
  escalate_to_user_id: null, is_mandatory: true, auto_skip: true, is_final: false, is_active: true,
})

export default function ApprovalRules() {
  const overview = useQuery<Overview[]>('wf-overview', () => api.get<Overview[]>('/workflow/overview'))
  const people = useQuery<Person[]>('wf-people', () => api.get<Person[]>('/people/directory'))
  const [error, setError] = useState<string | null>(null)

  if (overview.error) return <ErrorNote>{overview.error}</ErrorNote>
  if (!overview.data) return <Loading />

  return (
    <>
      <section className="card hs-card">
        <header className="hs-card-head ar-head">
          <h2>Approval rules</h2>
          <span className="lp-note">Saved now, used by every request type below</span>
        </header>
        <div className="hs-card-body">
          <p className="ar-intro">
            Each request type follows the levels configured here, in order. A level says <i>which role</i> approves — who that turns
            out to be is read from the employee’s own Reporting Manager and Head of Department in Employees. A level with nobody
            assigned is skipped when Auto-skip is on, so one flow covers people who have both, one, or neither.
          </p>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="ar-list">
            {overview.data.map((row) => (
              <KindCard key={row.flow.kind} row={row} people={people.data ?? []} onSaved={() => overview.reload()} onError={setError} />
            ))}
          </div>
        </div>
      </section>
    </>
  )
}

function KindCard({
  row, people, onSaved, onError,
}: {
  row: Overview
  people: Person[]
  onSaved: () => void
  onError: (message: string | null) => void
}) {
  const kind = row.flow.kind
  const [open, setOpen] = useState(false)
  const [levels, setLevels] = useState<LevelRow[]>(row.levels)
  const [flow, setFlow] = useState<Flow>(row.flow)
  const [busy, setBusy] = useState(false)
  // A reload after a save brings the stored rows back in.
  useEffect(() => { setLevels(row.levels); setFlow(row.flow) }, [row])

  const dirty = JSON.stringify({ levels, flow }) !== JSON.stringify({ levels: row.levels, flow: row.flow })
  const active = levels.filter((l) => l.is_active)

  const patch = (index: number, change: Partial<LevelRow>) => setLevels(levels.map((l, i) => (i === index ? { ...l, ...change } : l)))
  const move = (index: number, by: number) => {
    const to = index + by
    if (to < 0 || to >= levels.length) return
    const next = [...levels]
    ;[next[index], next[to]] = [next[to], next[index]]
    setLevels(next)
  }

  async function toggleEnabled(on: boolean) {
    onError(null)
    try {
      await api.put(`/workflow/flows/${kind}`, { is_enabled: on })
      onSaved()
    } catch (err) {
      onError((err as { message?: string }).message ?? 'That could not be changed')
    }
  }

  async function save() {
    for (const [i, l] of levels.entries()) {
      if (l.reviewer_rule === 'named_user' && !l.reviewer_user_id) return onError(`Level ${i + 1} names a person but none was chosen.`)
    }
    setBusy(true)
    onError(null)
    try {
      await api.put(`/workflow/flows/${kind}`, {
        sequential: flow.sequential, reject_ends: flow.reject_ends, notify_approver: flow.notify_approver,
      })
      await api.put(`/workflow/levels/${kind}`, {
        levels: levels.map((l) => ({
          reviewer_rule: l.reviewer_rule,
          reviewer_user_id: l.reviewer_rule === 'named_user' ? l.reviewer_user_id : null,
          auto_forward_days: l.auto_forward_days,
          escalate_after_days: l.escalate_after_days,
          escalate_to_user_id: l.escalate_to_user_id,
          is_mandatory: l.is_mandatory,
          auto_skip: l.auto_skip,
          is_final: l.is_final,
          is_active: l.is_active,
        })),
      })
      onSaved()
    } catch (err) {
      onError((err as { message?: string }).message ?? 'That could not be saved')
    } finally {
      setBusy(false)
    }
  }

  // "Employee → RM → HOD → Approved. One level at a time. …"
  const path = ['Employee', ...active.map((l) => {
    const who = l.reviewer_rule === 'named_user'
      ? people.find((p) => p.user_id === l.reviewer_user_id)?.full_name ?? 'Person'
      : APPROVERS.find((a) => a.value === l.reviewer_rule)?.short ?? l.reviewer_rule
    return `${who}${l.is_mandatory ? '' : '*'}`
  }), 'Approved'].join(' → ')
  const sentences = [
    flow.sequential ? 'One level at a time.' : 'Every level is asked at once.',
    active.some((l) => l.auto_skip) ? 'A level with nobody assigned is skipped.' : 'A level with nobody assigned waits as unassigned.',
    active.some((l) => l.is_final) ? 'A final level ends it on approval.' : '',
    !flow.reject_ends ? 'A rejection at an optional level does not end it.' : '',
    active.some((l) => !l.is_mandatory) ? 'An optional level is marked *.' : '',
  ].filter(Boolean)

  return (
    <div className={`ar-kind${open ? ' is-open' : ''}`}>
      <div className="ar-kind-head">
        <label className="crm-check ar-kind-name">
          <input type="checkbox" checked={row.flow.is_enabled} onChange={(e) => void toggleEnabled(e.target.checked)} aria-label={`${KIND[kind] ?? kind} enabled`} />
          <b>{KIND[kind] ?? kind}</b>
        </label>
        <span className="ar-count">{row.levels.length} level{row.levels.length === 1 ? '' : 's'}</span>
        <button type="button" className="btn btn-sm ar-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide' : 'Configure'}
        </button>
      </div>

      {open && (
        <div className="ar-body">
          <div className="ar-table-wrap">
            <table className="ar-table">
              <thead>
                <tr><th>Level</th><th>Approver</th><th>Mandatory</th><th>Auto skip</th><th>Final</th><th>Active</th><th /></tr>
              </thead>
              <tbody>
                {levels.map((l, i) => (
                  <tr key={l.id ?? `new-${i}`}>
                    <td><span className="ar-level">{i + 1}</span></td>
                    <td>
                      <select value={l.reviewer_rule} onChange={(e) => patch(i, { reviewer_rule: e.target.value, reviewer_user_id: null })} aria-label={`Level ${i + 1} approver`}>
                        {APPROVERS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                      </select>
                      {l.reviewer_rule === 'named_user' && (
                        <select value={l.reviewer_user_id ?? ''} onChange={(e) => patch(i, { reviewer_user_id: e.target.value || null })} aria-label={`Level ${i + 1} person`}>
                          <option value="">Choose…</option>
                          {people.map((p) => <option key={p.user_id} value={p.user_id}>{p.full_name}</option>)}
                        </select>
                      )}
                    </td>
                    <td className="c"><input type="checkbox" checked={l.is_mandatory} onChange={(e) => patch(i, { is_mandatory: e.target.checked })} aria-label={`Level ${i + 1} mandatory`} /></td>
                    <td className="c"><input type="checkbox" checked={l.auto_skip} onChange={(e) => patch(i, { auto_skip: e.target.checked })} aria-label={`Level ${i + 1} auto skip`} /></td>
                    <td className="c"><input type="checkbox" checked={l.is_final} onChange={(e) => patch(i, { is_final: e.target.checked })} aria-label={`Level ${i + 1} final`} /></td>
                    <td className="c"><input type="checkbox" checked={l.is_active} onChange={(e) => patch(i, { is_active: e.target.checked })} aria-label={`Level ${i + 1} active`} /></td>
                    <td className="ar-actions">
                      <button type="button" className="ar-icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up" title="Move up">↑</button>
                      <button type="button" className="ar-icon" disabled={i === levels.length - 1} onClick={() => move(i, 1)} aria-label="Move down" title="Move down">↓</button>
                      <button type="button" className="ar-icon ar-del" onClick={() => setLevels(levels.filter((_, j) => j !== i))} aria-label="Delete level" title="Delete level">🗑</button>
                    </td>
                  </tr>
                ))}
                {levels.length === 0 && (
                  <tr><td colSpan={7} className="ar-none">No levels. Requests of this type are decided in one step.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="ar-toolbar">
            <button type="button" className="btn btn-sm" disabled={levels.length >= MAX_LEVELS} onClick={() => setLevels([...levels, blank()])}>
              <IconPlus size={13} /> Add level
            </button>
            <label className="ar-pill"><input type="checkbox" checked={flow.sequential} onChange={(e) => setFlow({ ...flow, sequential: e.target.checked })} /> Sequential approval</label>
            <label className="ar-pill"><input type="checkbox" checked={flow.reject_ends} onChange={(e) => setFlow({ ...flow, reject_ends: e.target.checked })} /> A rejection ends it</label>
            <label className="ar-pill"><input type="checkbox" checked={flow.notify_approver} onChange={(e) => setFlow({ ...flow, notify_approver: e.target.checked })} /> Notify the approver</label>
          </div>

          <p className="ar-summary">
            {levels.length === 0 ? 'Employee → Approved. Decided in one step.' : `${path}. ${sentences.join(' ')}`}
          </p>

          {dirty && (
            <div className="ar-save">
              <button type="button" className="btn" disabled={busy} onClick={() => { setLevels(row.levels); setFlow(row.flow) }}>Discard</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
