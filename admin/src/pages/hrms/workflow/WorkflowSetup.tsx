/* Approval chains: who signs off what, and in which order.
 *
 * The screen is careful about one thing above all: **making it obvious when a
 * chain is inherited rather than local.** An administrator opening a
 * department's chain and seeing three levels has to know whether those three
 * are the department's own or the company's — because "Save" on an inherited
 * chain silently creates a local copy that then stops tracking the company one.
 * So a department with no rows of its own says so in words, shows the inherited
 * chain greyed, and offers "override" as an explicit act.
 *
 * Two other things it states rather than assumes:
 *
 * **No chain means single-level approval**, which is what every flow does today
 * and what most companies want. The empty state says that, so nobody reads a
 * blank screen as broken configuration.
 *
 * **Editing does not touch requests already in flight.** Their chain was
 * written when they were submitted. Somebody adding a third level and expecting
 * yesterday's claims to route through it will otherwise file a bug.
 */

import { useEffect, useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import './workflow.css'

interface Level {
  id?: string
  level?: number
  reviewer_rule: string
  reviewer_user_id: string | null
  auto_forward_days: number
  escalate_after_days: number
  escalate_to_user_id: string | null
  reviewer_name?: string | null
  escalate_to_name?: string | null
}

interface Person {
  user_id: string
  full_name: string
}

/** What each rule means, in the words an administrator would use. */
const RULES: Array<{ value: string; label: string; hint: string }> = [
  {
    value: 'reporting_manager',
    label: "The requester's manager",
    hint: 'Resolved when they submit. The usual first level.',
  },
  {
    value: 'skip_level_manager',
    label: "Their manager's manager",
    hint: 'Resolves to nobody at the top of the tree — that level then shows unassigned.',
  },
  {
    value: 'department_head',
    label: 'Their department head',
    hint: 'Skipped when it resolves to the requester themselves.',
  },
  {
    value: 'named_user',
    label: 'A specific person',
    hint: 'For "all loans go to Anita". Breaks visibly if they leave, rather than silently.',
  },
  {
    value: 'capability',
    label: 'Anyone with the permission',
    hint: 'A queue rather than a person: the first holder to act decides.',
  },
]

const KIND_LABEL: Record<string, string> = {
  leave: 'Leave',
  timesheet: 'Timesheets',
  regularization: 'Attendance corrections',
  expense: 'Expense claims',
  loan: 'Loans & advances',
  performance: 'Performance reviews',
}

function blankLevel(): Level {
  return {
    reviewer_rule: 'reporting_manager',
    reviewer_user_id: null,
    auto_forward_days: 0,
    escalate_after_days: 0,
    escalate_to_user_id: null,
  }
}

export default function WorkflowSetup() {
  const kindsQ = useQuery<string[]>('wf-kinds', () => api.get<string[]>('/workflow/kinds'))
  const peopleQ = useQuery<Person[]>('wf-people', () => api.get<Person[]>('/people/directory'))
  const deptQ = useQuery<Array<{ id: string; name: string }>>('wf-depts', () =>
    api.get('/org/departments'),
  )
  const [kind, setKind] = useState<string | null>(null)
  const [departmentId, setDepartmentId] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  const kinds = kindsQ.data ?? []
  useEffect(() => {
    if (!kind && kinds.length) setKind(kinds[0])
  }, [kind, kinds])

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Approval workflow</h1>
          <p className="muted">
            Route requests through up to five levels, with escalation when
            nobody answers. A flow with no chain is approved in one step by
            whoever already has the permission — which is how every flow works
            until you change it here.
          </p>
        </div>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      {kindsQ.loading ? (
        <Loading />
      ) : (
        <>
          <div className="wf-tabs">
            {kinds.map((k) => (
              <button key={k} className={`chip${k === kind ? ' is-on' : ''}`}
                      onClick={() => setKind(k)}>
                {KIND_LABEL[k] ?? k}
              </button>
            ))}
          </div>

          <div className="wf-scope">
            <label className="wf-field">
              <span className="wf-label">Applies to</span>
              <select value={departmentId}
                      onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">Everyone in the company</option>
                {(deptQ.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
              <span className="muted">
                A department chain <strong>replaces</strong> the company one for
                its people — it does not add to it.
              </span>
            </label>
          </div>

          {kind && (
            <ChainEditor
              key={`${kind}:${departmentId}`}
              kind={kind}
              departmentId={departmentId || null}
              people={peopleQ.data ?? []}
              onError={setError}
            />
          )}
        </>
      )}
    </div>
  )
}

function ChainEditor({
  kind,
  departmentId,
  people,
  onError,
}: {
  kind: string
  departmentId: string | null
  people: Person[]
  onError: (m: string | null) => void
}) {
  const scope = departmentId ? `?department_id=${departmentId}` : ''
  const ownQ = useQuery<Level[]>(`wf-own-${kind}-${departmentId}`, () =>
    api.get<Level[]>(`/workflow/levels/${kind}${scope}`),
  )
  const effectiveQ = useQuery<Level[]>(`wf-eff-${kind}-${departmentId}`, () =>
    api.get<Level[]>(`/workflow/levels/${kind}/effective${scope}`),
  )
  const [levels, setLevels] = useState<Level[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (ownQ.data) setLevels(ownQ.data.map((l) => ({ ...l })))
  }, [ownQ.data])

  if (ownQ.loading || effectiveQ.loading) return <Loading />
  const own = ownQ.data ?? []
  const effective = effectiveQ.data ?? []
  const rows = levels ?? []

  /* Inherited: this department has no rows of its own but the company does.
     Saying so in words matters — "Save" on an inherited chain silently creates
     a local copy that then stops tracking the company one. */
  const inherited = departmentId !== null && own.length === 0 && effective.length > 0

  async function save(next: Level[]) {
    setBusy(true)
    onError(null)
    try {
      await api.put(`/workflow/levels/${kind}${scope}`, {
        levels: next.map((l) => ({
          reviewer_rule: l.reviewer_rule,
          reviewer_user_id: l.reviewer_user_id,
          auto_forward_days: l.auto_forward_days,
          escalate_after_days: l.escalate_after_days,
          escalate_to_user_id: l.escalate_to_user_id,
        })),
      })
      ownQ.reload()
      effectiveQ.reload()
    } catch (caught) {
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (inherited) {
    return (
      <section className="card">
        <h2 className="card-title">Inherited from the company chain</h2>
        <p className="muted">
          This department has no chain of its own, so requests from its people
          follow the company-wide one below. Overriding creates a separate chain
          that stops following the company one — including later changes to it.
        </p>
        <ol className="wf-levels is-inherited">
          {effective.map((l, i) => (
            <li key={i}>
              <span className="wf-level-no">{i + 1}</span>
              <span>{describe(l)}</span>
            </li>
          ))}
        </ol>
        <button className="btn" disabled={busy}
                onClick={() => setLevels(effective.map((l) => ({ ...l })))}>
          Override for this department
        </button>
      </section>
    )
  }

  return (
    <section className="card">
      <h2 className="card-title">
        {rows.length ? `${rows.length} level${rows.length === 1 ? '' : 's'}` : 'No chain'}
      </h2>

      {!rows.length && (
        <Empty>
          No chain. Requests are approved in one step by whoever holds the
          permission — which is how this flow works today, and is right for most
          companies.
        </Empty>
      )}

      {rows.map((level, index) => (
        <div className="wf-level" key={index}>
          <span className="wf-level-no">{index + 1}</span>
          <div className="wf-level-body">
            <div className="wf-row">
              <select
                value={level.reviewer_rule}
                onChange={(e) => setLevels(rows.map((l, i) =>
                  i === index ? { ...l, reviewer_rule: e.target.value } : l))}
              >
                {RULES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
              {level.reviewer_rule === 'named_user' && (
                <select
                  value={level.reviewer_user_id ?? ''}
                  onChange={(e) => setLevels(rows.map((l, i) =>
                    i === index ? { ...l, reviewer_user_id: e.target.value || null } : l))}
                >
                  <option value="">Choose a person…</option>
                  {people.map((p) => (
                    <option key={p.user_id} value={p.user_id}>{p.full_name}</option>
                  ))}
                </select>
              )}
              <button className="btn small"
                      onClick={() => setLevels(rows.filter((_, i) => i !== index))}>
                Remove
              </button>
            </div>
            <span className="muted">
              {RULES.find((r) => r.value === level.reviewer_rule)?.hint}
            </span>

            <div className="wf-row">
              <label className="wf-field">
                <span className="wf-label">Escalate after</span>
                <input type="number" min={0} max={90} value={level.escalate_after_days}
                       onChange={(e) => setLevels(rows.map((l, i) =>
                         i === index
                           ? { ...l, escalate_after_days: Number(e.target.value) }
                           : l))} />
                <span className="muted">days · 0 = never</span>
              </label>
              {level.escalate_after_days > 0 && (
                <label className="wf-field">
                  <span className="wf-label">Escalate to</span>
                  <select value={level.escalate_to_user_id ?? ''}
                          onChange={(e) => setLevels(rows.map((l, i) =>
                            i === index
                              ? { ...l, escalate_to_user_id: e.target.value || null }
                              : l))}>
                    <option value="">Choose a person…</option>
                    {people.map((p) => (
                      <option key={p.user_id} value={p.user_id}>{p.full_name}</option>
                    ))}
                  </select>
                  <span className="muted">
                    Reassigns this level to them. It still needs deciding.
                  </span>
                </label>
              )}
              <label className="wf-field">
                <span className="wf-label">Auto-forward after</span>
                <input type="number" min={0} max={90} value={level.auto_forward_days}
                       onChange={(e) => setLevels(rows.map((l, i) =>
                         i === index
                           ? { ...l, auto_forward_days: Number(e.target.value) }
                           : l))} />
                <span className="muted">
                  days · 0 = never. Skips this level entirely — use sparingly.
                </span>
              </label>
            </div>
          </div>
        </div>
      ))}

      <div className="wf-actions">
        {rows.length < 5 && (
          <button className="btn" onClick={() => setLevels([...rows, blankLevel()])}>
            Add a level
          </button>
        )}
        <button className="btn primary" disabled={busy} onClick={() => save(rows)}>
          Save chain
        </button>
        {own.length > 0 && (
          <button className="btn" disabled={busy} onClick={() => save([])}>
            Remove the chain
          </button>
        )}
        <span className="muted">
          Requests already submitted keep the chain they started with — this
          changes what happens to the next one.
        </span>
      </div>
    </section>
  )
}

function describe(level: Level): string {
  const rule = RULES.find((r) => r.value === level.reviewer_rule)?.label ?? level.reviewer_rule
  const who = level.reviewer_name ? `${rule} — ${level.reviewer_name}` : rule
  const bits = [who]
  if (level.escalate_after_days) {
    bits.push(
      `escalates after ${level.escalate_after_days}d` +
      (level.escalate_to_name ? ` to ${level.escalate_to_name}` : ''),
    )
  }
  if (level.auto_forward_days) bits.push(`auto-forwards after ${level.auto_forward_days}d`)
  return bits.join(' · ')
}
