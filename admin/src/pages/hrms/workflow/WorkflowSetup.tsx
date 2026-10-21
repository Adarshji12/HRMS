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
import { EmptyState, ErrorNote, Loading } from '../../../components/ui'
import Tabs from '../../../components/Tabs'
import { IconSitemap } from '../../../components/Icons'
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
  purchase_requisition: 'ERP · Purchase requisitions',
  purchase_order: 'ERP · Purchase orders',
  stock_adjustment: 'ERP · Stock adjustments',
  sales_order: 'ERP · Sales orders',
  credit_note: 'ERP · Credit notes',
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
            Route requests through up to five levels, escalating when nobody answers.
          </p>
        </div>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      {kindsQ.loading ? (
        <Loading />
      ) : (
        <>
          {/* The shared tab bar, not six loose buttons. They carried
              `className="chip"`, which is defined nowhere — so they rendered as
              bare UA buttons with no selected state at all, and the flow you
              were editing was indistinguishable from the five you were not.
              Tabs also brings the real role=tablist semantics and arrow-key
              behaviour with it. */}
          {/* Guarded on `kind`: it is null until the flow list loads, and a tab
              bar with no selected tab has no thumb to place. */}
          {kind && (
            <Tabs
              label="Approval flows"
              items={kinds.map((k) => ({ id: k, label: KIND_LABEL[k] ?? k }))}
              value={kind}
              onChange={setKind}
            />
          )}

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
            </label>
            {/* Out of the label. Inside it, the hint was a third stacked child
                of a column flex and stretched the select to the full page
                width — a 1200px dropdown holding "Everyone in the company". */}
            <p className="wf-scope-hint">
              A department chain <strong>replaces</strong> the company one for
              its people — it does not add to it.
            </p>
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

          {/* Conditions come after the plain chain deliberately: the chain is
              what a flow does by default, and the rules are the exceptions to
              it. Reading them the other way round makes the default look like
              an afterthought. They are company-wide rather than per department,
              because a rule can already ask which department somebody is in —
              two ways to express the same routing is two places to look. */}
          {kind && (
            <RuleEditor
              key={`rules:${kind}`}
              kind={kind}
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
            No chain of its own — requests from its people follow the company chain below.
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
      {/* Names the panel, not its state. It used to read "No chain" while the
          empty state below it also read "No chain" — the same two words twice,
          six lines apart. The count is genuinely useful once there IS a chain,
          so it stays for that case. */}
      <h2 className="card-title">
        {rows.length ? `Chain · ${rows.length} level${rows.length === 1 ? '' : 's'}` : 'Approval chain'}
      </h2>

      {!rows.length && (
        <EmptyState
          icon={<IconSitemap size={22} />}
          title="No chain"
          body="Requests are approved in one step by whoever holds the permission — which is how this flow works today, and is right for most companies. Add a level to route them through someone first."
        />
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
          <button className="btn btn-danger" disabled={busy} onClick={() => save([])}>
            Remove the chain
          </button>
        )}
      </div>
      {/* Below the buttons, not beside them. Inline it was a 90-character
          sentence sharing a flex row with three controls, which made the row
          scan as four buttons of wildly different widths. */}
      <p className="wf-caveat">
        Requests already submitted keep the chain they started with — this
        changes what happens to the next one.
      </p>
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

/* ------------------------------------------------------- conditional rules -- */

interface Condition {
  field: string
  op: string
  value: unknown
}

interface Rule {
  id?: string
  name: string
  priority: number | null
  conditions: Condition[]
  levels: Level[]
  is_fallback: boolean
  is_active: boolean
}

interface VocabField {
  key: string
  label: string
  type: 'money' | 'number' | 'days' | 'choice' | 'id' | 'text'
  options: string | null
  help: string | null
}

interface Vocabulary {
  fields: VocabField[]
  operators: Record<string, string>
}

/** Where a `choice`/`id` field gets its options. One place, so a new field with
 *  an options key nobody wired up renders as a plain box rather than an empty
 *  dropdown that looks broken. */
const OPTION_SOURCES: Record<string, { path: string; id: string; label: string }> = {
  departments: { path: '/org/departments', id: 'id', label: 'name' },
  teams: { path: '/org/teams', id: 'id', label: 'name' },
  designations: { path: '/org/designations', id: 'id', label: 'name' },
  projects: { path: '/projects', id: 'id', label: 'name' },
  'leave-types': { path: '/leave/types', id: 'id', label: 'name' },
  'expense-categories': { path: '/expenses/categories', id: 'id', label: 'name' },
}

const ROLE_OPTIONS = [
  { id: 'employee', name: 'Employee' },
  { id: 'manager', name: 'Manager' },
  { id: 'admin', name: 'Administrator' },
  { id: 'owner', name: 'Owner' },
]

function blankRule(): Rule {
  return {
    name: '',
    priority: null,
    conditions: [{ field: '', op: 'gt', value: '' }],
    levels: [blankLevel()],
    is_fallback: false,
    is_active: true,
  }
}

/**
 * Conditional routing: a condition, and the whole chain to use when it holds.
 *
 * **First match wins, top to bottom.** The order of the list *is* the routing,
 * which is why the whole set saves in one write rather than a rule at a time: a
 * reorder saved piecemeal is three saves any of which can fail half way, and
 * what is left is a routing nobody chose.
 *
 * The fallback row sits at the bottom and cannot be dragged out of it. A
 * fallback that ran first would match everything and make every rule above it
 * dead — a misconfiguration nobody would spot by reading the screen.
 */
function RuleEditor({
  kind,
  people,
  onError,
}: {
  kind: string
  people: Person[]
  onError: (message: string | null) => void
}) {
  const vocabQ = useQuery<Vocabulary>(`wf-vocab-${kind}`, () =>
    api.get<Vocabulary>(`/workflow/vocabulary/${kind}`),
  )
  const rulesQ = useQuery<Rule[]>(`wf-rules-${kind}`, () =>
    api.get<Rule[]>(`/workflow/rules/${kind}`),
  )

  const [draft, setDraft] = useState<Rule[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!rulesQ.data || !vocabQ.data) return
    setDraft(
      rulesQ.data.map((rule) => ({
        ...rule,
        conditions: rule.conditions.map((clause) => ({
          ...clause,
          value: display(clause, vocabQ.data),
        })),
      })),
    )
    // Waits for the vocabulary as well as the rules: `display` needs to know
    // which fields are money, and running before it arrives would put paise in
    // a box labelled ₹ — which the next save would multiply by a hundred.
  }, [rulesQ.data, vocabQ.data])

  const vocab = vocabQ.data
  const rules = draft ?? []

  function patch(index: number, changes: Partial<Rule>) {
    setSaved(false)
    setDraft((current) =>
      (current ?? []).map((rule, i) => (i === index ? { ...rule, ...changes } : rule)),
    )
  }

  function move(index: number, delta: number) {
    setSaved(false)
    setDraft((current) => {
      const next = [...(current ?? [])]
      const target = index + delta
      if (target < 0 || target >= next.length) return next
      // A fallback cannot be moved out of last place, and nothing can be moved
      // below it — see the note on this component.
      if (next[index].is_fallback || next[target].is_fallback) return next
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  async function save() {
    setBusy(true)
    onError(null)
    try {
      const body = {
        rules: rules.map((rule, index) => ({
          name: rule.name.trim() || `Rule ${index + 1}`,
          priority: (index + 1) * 10,
          conditions: rule.is_fallback
            ? []
            : rule.conditions
                .filter((c) => c.field && c.value !== '' && c.value !== null)
                .map((c) => ({ ...c, value: coerce(c, vocab) })),
          levels: rule.levels.map((level) => ({
            reviewer_rule: level.reviewer_rule,
            reviewer_user_id: level.reviewer_user_id,
            auto_forward_days: level.auto_forward_days,
            escalate_after_days: level.escalate_after_days,
            escalate_to_user_id: level.escalate_to_user_id,
          })),
          is_fallback: rule.is_fallback,
          is_active: rule.is_active,
        })),
      }
      await api.put(`/workflow/rules/${kind}`, body)
      await rulesQ.reload()
      setSaved(true)
    } catch (caught) {
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (vocabQ.loading || rulesQ.loading) return <Loading />
  if (!vocab) return <ErrorNote>{vocabQ.error ?? 'Could not read the conditions.'}</ErrorNote>

  const hasFallback = rules.some((rule) => rule.is_fallback)

  return (
    <section className="wf-rules">
      <div className="wf-rules-head">
        <div>
          <h2 className="wf-rules-title">Conditional routing</h2>
          <p className="muted">
            The first rule that matches supplies the whole chain. A request matching nothing
            falls to the plain chain above — which is what happens today, so a flow with no
            rules behaves exactly as it did.
          </p>
        </div>
        <div className="wf-rules-actions">
          {saved && <span className="wf-saved">Saved</span>}
          <button
            className="btn"
            onClick={() => {
              setSaved(false)
              setDraft((current) => {
                const next = [...(current ?? [])]
                // A new rule goes above the fallback, never below it.
                const at = next.findIndex((rule) => rule.is_fallback)
                const made = blankRule()
                if (at === -1) next.push(made)
                else next.splice(at, 0, made)
                return next
              })
            }}
          >
            Add a rule
          </button>
          {!hasFallback && (
            <button
              className="btn"
              onClick={() => {
                setSaved(false)
                setDraft((current) => [
                  ...(current ?? []),
                  { ...blankRule(), name: 'Everything else', is_fallback: true, conditions: [] },
                ])
              }}
            >
              Add “everything else”
            </button>
          )}
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save rules'}
          </button>
        </div>
      </div>

      {rules.length === 0 ? (
        <EmptyState
          icon={<IconSitemap size={20} />}
          title="No conditions on this flow"
          body="Every request takes the chain above. Add a rule to route by amount, type, or who is asking — for example, expenses over ₹50,000 through an extra level."
        />
      ) : (
        <ol className="wf-rule-list">
          {rules.map((rule, index) => (
            <li
              className={`wf-rule${rule.is_fallback ? ' is-fallback' : ''}${
                rule.is_active ? '' : ' is-off'
              }`}
              key={rule.id ?? index}
            >
              <div className="wf-rule-head">
                <span className="wf-rule-order">{index + 1}</span>
                <input
                  className="wf-rule-name"
                  value={rule.name}
                  placeholder={rule.is_fallback ? 'Everything else' : 'What is this rule for?'}
                  onChange={(e) => patch(index, { name: e.target.value })}
                />
                <div className="wf-rule-tools">
                  {!rule.is_fallback && (
                    <>
                      <button
                        className="wf-move"
                        onClick={() => move(index, -1)}
                        disabled={index === 0}
                        aria-label="Move up"
                        title="Evaluate earlier"
                      >
                        ↑
                      </button>
                      <button
                        className="wf-move"
                        onClick={() => move(index, 1)}
                        disabled={index >= rules.length - 1 || rules[index + 1]?.is_fallback}
                        aria-label="Move down"
                        title="Evaluate later"
                      >
                        ↓
                      </button>
                    </>
                  )}
                  <label className="wf-toggle" title="Switched-off rules are skipped">
                    <input
                      type="checkbox"
                      checked={rule.is_active}
                      onChange={(e) => patch(index, { is_active: e.target.checked })}
                    />
                    {rule.is_active ? 'On' : 'Off'}
                  </label>
                  <button
                    className="wf-remove"
                    onClick={() => {
                      setSaved(false)
                      setDraft((current) => (current ?? []).filter((_, i) => i !== index))
                    }}
                    aria-label="Remove this rule"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {rule.is_fallback ? (
                <p className="wf-rule-when muted">
                  Matches anything the rules above did not. Always evaluated last.
                </p>
              ) : (
                <div className="wf-when">
                  <span className="wf-when-label">When</span>
                  <div className="wf-clauses">
                    {rule.conditions.map((clause, clauseIndex) => (
                      <ClauseRow
                        key={clauseIndex}
                        clause={clause}
                        vocab={vocab}
                        first={clauseIndex === 0}
                        onChange={(next) =>
                          patch(index, {
                            conditions: rule.conditions.map((c, i) =>
                              i === clauseIndex ? next : c,
                            ),
                          })
                        }
                        onRemove={() =>
                          patch(index, {
                            conditions: rule.conditions.filter((_, i) => i !== clauseIndex),
                          })
                        }
                      />
                    ))}
                    <button
                      className="wf-add-clause"
                      onClick={() =>
                        patch(index, {
                          conditions: [
                            ...rule.conditions,
                            { field: '', op: 'gt', value: '' },
                          ],
                        })
                      }
                    >
                      + and…
                    </button>
                  </div>
                </div>
              )}

              <div className="wf-then">
                <span className="wf-when-label">Then</span>
                <div className="wf-then-levels">
                  {rule.levels.map((level, levelIndex) => (
                    <div className="wf-then-level" key={levelIndex}>
                      <span className="wf-then-num">{levelIndex + 1}</span>
                      <select
                        value={level.reviewer_rule}
                        onChange={(e) =>
                          patch(index, {
                            levels: rule.levels.map((l, i) =>
                              i === levelIndex ? { ...l, reviewer_rule: e.target.value } : l,
                            ),
                          })
                        }
                      >
                        {RULES.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      {level.reviewer_rule === 'named_user' && (
                        <select
                          value={level.reviewer_user_id ?? ''}
                          onChange={(e) =>
                            patch(index, {
                              levels: rule.levels.map((l, i) =>
                                i === levelIndex
                                  ? { ...l, reviewer_user_id: e.target.value || null }
                                  : l,
                              ),
                            })
                          }
                        >
                          <option value="">Choose somebody…</option>
                          {people.map((person) => (
                            <option key={person.user_id} value={person.user_id}>
                              {person.full_name}
                            </option>
                          ))}
                        </select>
                      )}
                      {rule.levels.length > 1 && (
                        <button
                          className="wf-remove"
                          onClick={() =>
                            patch(index, {
                              levels: rule.levels.filter((_, i) => i !== levelIndex),
                            })
                          }
                          aria-label={`Remove level ${levelIndex + 1}`}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                  {rule.levels.length < 5 && (
                    <button
                      className="wf-add-clause"
                      onClick={() =>
                        patch(index, { levels: [...rule.levels, blankLevel()] })
                      }
                    >
                      + another level
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      {rules.length > 0 && !hasFallback && (
        <p className="wf-rules-note">
          There is no “everything else” rule, so a request matching none of these takes the
          plain chain above. That is a perfectly good arrangement — add one only if the
          unmatched case needs its own chain.
        </p>
      )}
    </section>
  )
}

/** One clause: a field, an operator, and a value shaped by the field's type. */
function ClauseRow({
  clause,
  vocab,
  first,
  onChange,
  onRemove,
}: {
  clause: Condition
  vocab: Vocabulary
  first: boolean
  onChange: (next: Condition) => void
  onRemove: () => void
}) {
  const field = vocab.fields.find((f) => f.key === clause.field) ?? null
  const source = field?.options ? OPTION_SOURCES[field.options] : null

  const optionsQ = useQuery<Array<Record<string, string>>>(
    `wf-options-${field?.options ?? 'none'}`,
    () => (source ? api.get<Array<Record<string, string>>>(source.path) : Promise.resolve([])),
    { enabled: Boolean(source) },
  )

  const options =
    field?.options === 'roles'
      ? ROLE_OPTIONS
      : (optionsQ.data ?? []).map((row) => ({
          id: String(row[source?.id ?? 'id']),
          name: String(row[source?.label ?? 'name']),
        }))

  /* Which operators make sense for this field. Offering "is more than" on a
     department produces a rule that can never match, and offering "is" on a
     multi-valued field has no honest answer. */
  const allowed = !field
    ? Object.keys(vocab.operators)
    : field.type === 'money' || field.type === 'number' || field.type === 'days'
      ? ['gt', 'gte', 'lt', 'lte', 'eq', 'ne']
      : field.key === 'category'
        ? ['any_of', 'none_of']
        : ['eq', 'ne', 'any_of', 'none_of']

  return (
    <div className="wf-clause">
      <span className="wf-clause-join">{first ? '' : 'and'}</span>

      <select
        value={clause.field}
        onChange={(e) => {
          const next = vocab.fields.find((f) => f.key === e.target.value)
          onChange({
            field: e.target.value,
            // The operator has to be one this field allows, or the rule saves
            // as something that can never match.
            op:
              next && ['money', 'number', 'days'].includes(next.type)
                ? 'gt'
                : next?.key === 'category'
                  ? 'any_of'
                  : 'eq',
            value: '',
          })
        }}
      >
        <option value="">Choose…</option>
        {vocab.fields.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>

      <select value={clause.op} onChange={(e) => onChange({ ...clause, op: e.target.value })}>
        {allowed.map((op) => (
          <option key={op} value={op}>
            {vocab.operators[op] ?? op}
          </option>
        ))}
      </select>

      {field?.type === 'money' ? (
        <span className="wf-money">
          <span aria-hidden="true">₹</span>
          <input
            inputMode="decimal"
            value={String(clause.value ?? '')}
            placeholder="50000"
            onChange={(e) => onChange({ ...clause, value: e.target.value })}
          />
        </span>
      ) : field?.type === 'number' || field?.type === 'days' ? (
        <input
          inputMode="decimal"
          value={String(clause.value ?? '')}
          placeholder={field.type === 'days' ? '3' : '0'}
          onChange={(e) => onChange({ ...clause, value: e.target.value })}
        />
      ) : options.length > 0 ? (
        <select
          value={
            Array.isArray(clause.value)
              ? String((clause.value as string[])[0] ?? '')
              : String(clause.value ?? '')
          }
          onChange={(e) =>
            onChange({
              ...clause,
              // The set operators take a list even when only one thing is
              // chosen — the server compares against a list either way.
              value: ['any_of', 'none_of'].includes(clause.op)
                ? [e.target.value]
                : e.target.value,
            })
          }
        >
          <option value="">Choose…</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={String(clause.value ?? '')}
          placeholder="value"
          onChange={(e) => onChange({ ...clause, value: e.target.value })}
        />
      )}

      <button className="wf-remove" onClick={onRemove} aria-label="Remove this condition">
        ✕
      </button>

      {/* Last, because it takes the full width of the row: anything after it
          wraps onto its own line. */}
      {field?.help && <span className="wf-clause-help">{field.help}</span>}
    </div>
  )
}

/** Turn what is stored back into what the box should show.
 *
 * The exact inverse of `coerce`, and it exists for one reason: without it,
 * reopening this page put paise into a field labelled ₹, and saving again
 * multiplied every money threshold by a hundred. A rule meant to fire at
 * ₹50,000 would then fire at ₹50,00,000 — silently, and only for the claims
 * nobody was watching. */
function display(clause: Condition, vocab: Vocabulary | undefined): unknown {
  const field = vocab?.fields.find((f) => f.key === clause.field)
  if (field?.type === 'money') {
    const paise = Number(clause.value)
    return Number.isFinite(paise) ? String(paise / 100) : ''
  }
  return clause.value
}

/** Turn what was typed into what the record stores.
 *
 * Money is the only conversion that matters: the box says rupees because that
 * is what people say, and every amount in this product is stored in paise. A
 * rule saved in rupees would fire at one hundredth of the intended threshold —
 * which is not a rounding error, it is a claim approved by the wrong people. */
function coerce(clause: Condition, vocab: Vocabulary | undefined): unknown {
  const field = vocab?.fields.find((f) => f.key === clause.field)
  if (!field) return clause.value
  if (field.type === 'money') {
    const rupees = Number(String(clause.value).replace(/[,\s₹]/g, ''))
    return Number.isFinite(rupees) ? Math.round(rupees * 100) : 0
  }
  if (field.type === 'number' || field.type === 'days') {
    const value = Number(clause.value)
    return Number.isFinite(value) ? value : 0
  }
  return clause.value
}
