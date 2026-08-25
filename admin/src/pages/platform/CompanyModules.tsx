/* Super Admin — which modules one company may use.

   The screen is three-state per module, not a checkbox, and that is the whole
   design. A checkbox can only say on or off, so the moment an operator touches
   one the company stops following its plan forever — and nothing on screen says
   so. Six months later the plan gains a module and one customer silently does
   not get it. So each row offers **Plan / On / Off**, where Plan is the default
   and means "whatever the plan says, now and later".

   Three server truths this file is built around:

   1. **Empty `plan.modules` means every module, not none.** A plan that was
      never given a module list is unrestricted, which is why the header says so
      in words rather than rendering an empty list the operator has to interpret.

   2. **The save replaces the override map; it does not merge.** Rows left on
      Plan are simply absent from the payload. There is no separate "clear"
      call to fall out of step with the save.

   3. **`planned` modules are not grantable.** They are declared in the registry
      so the roadmap is visible here, but the server rejects a grant naming one,
      because a switch that grants access to routes which do not exist is a
      support ticket. They render disabled with their status. */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ErrorNote } from '../../components/ui'
import {
  platformApi,
  type CompanyModule,
  type CompanyModules as CompanyModulesPayload,
  type ModuleGrant,
} from '../../lib/platformApi'

/** null = follow the plan. Matches the server's "absent means inherit". */
type Choice = boolean | null

function groupsOf(modules: CompanyModule[]): [string, CompanyModule[]][] {
  const order: string[] = []
  const bucket = new Map<string, CompanyModule[]>()
  for (const module of modules) {
    if (!bucket.has(module.group)) {
      bucket.set(module.group, [])
      order.push(module.group)
    }
    bucket.get(module.group)!.push(module)
  }
  // Registry order, not alphabetical — it is grouped the way the product is
  // sold, and re-sorting here would silently diverge from the plan editor.
  return order.map((name) => [name, bucket.get(name)!])
}

export default function CompanyModules({ orgId }: { orgId: string }) {
  const [payload, setPayload] = useState<CompanyModulesPayload | null>(null)
  const [draft, setDraft] = useState<Record<string, Choice>>({})
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const fresh = await platformApi.companyModules(orgId)
      setPayload(fresh)
      setDraft(Object.fromEntries(fresh.modules.map((m) => [m.key, m.override])))
      setError(null)
    } catch (caught) {
      setError((caught as Error).message)
    }
  }, [orgId])

  useEffect(() => {
    void load()
  }, [load])

  /* Compared against the server's map rather than a local `touched` flag, so
     switching a row away and back again correctly reads as no change. */
  const dirty = useMemo(() => {
    if (!payload) return false
    return payload.modules.some((m) => (draft[m.key] ?? null) !== m.override)
  }, [payload, draft])

  async function save() {
    setBusy(true)
    setNote(null)
    try {
      const grants: ModuleGrant[] = Object.entries(draft)
        .filter(([, choice]) => choice !== null)
        .map(([key, choice]) => ({ key, enabled: choice as boolean }))
      const fresh = await platformApi.saveCompanyModules(orgId, grants)
      setPayload(fresh)
      setDraft(Object.fromEntries(fresh.modules.map((m) => [m.key, m.override])))
      setError(null)
      setNote('Modules updated. The change applies on the customer’s next request.')
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function reset() {
    if (!payload) return
    setDraft(Object.fromEntries(payload.modules.map((m) => [m.key, m.override])))
    setNote(null)
  }

  if (error && !payload) return <ErrorNote>{error}</ErrorNote>
  if (!payload) return <section className="pf-card"><p className="pf-muted">Loading modules…</p></section>

  return (
    <section className="pf-card">
      <h2 className="pf-card-title">Modules</h2>
      <p className="pf-muted pf-card-sub">
        On the <strong>{payload.plan_name}</strong> plan
        {payload.plan_unrestricted
          ? ' — which includes every module. '
          : ' — which includes only some modules. '}
        Leave a module on <strong>Plan</strong> to keep following it. Setting
        <strong> On</strong> or <strong>Off</strong> overrides the plan for this
        company only, now and after any plan change.
      </p>

      {error && <ErrorNote>{error}</ErrorNote>}
      {note && <p className="pf-ok">{note}</p>}

      {groupsOf(payload.modules).map(([group, modules]) => (
        <div key={group} className="pf-module-group">
          <h3 className="pf-module-group-title">{group}</h3>
          {modules.map((module) => (
            <ModuleRow
              key={module.key}
              module={module}
              choice={draft[module.key] ?? null}
              disabled={busy}
              onChange={(next) => setDraft((prev) => ({ ...prev, [module.key]: next }))}
            />
          ))}
        </div>
      ))}

      <div className="pf-actions">
        <button className="btn primary" onClick={save} disabled={!dirty || busy}>
          {busy ? 'Saving…' : 'Save modules'}
        </button>
        <button className="btn" onClick={reset} disabled={!dirty || busy}>
          Discard
        </button>
      </div>
    </section>
  )
}

function ModuleRow({
  module,
  choice,
  disabled,
  onChange,
}: {
  module: CompanyModule
  choice: Choice
  disabled: boolean
  onChange: (next: Choice) => void
}) {
  const planned = !module.grantable
  /* What the module resolves to given the *pending* choice, so the row's state
     line reflects what Save would do rather than what the last save did. */
  const effective = choice === null ? module.in_plan : choice

  return (
    <div className={`pf-module-row${planned ? ' is-planned' : ''}`}>
      <div className="pf-module-text">
        <div className="pf-module-name">
          {module.label}
          {planned && <span className="pf-chip">Not built yet</span>}
          {!planned && choice !== null && <span className="pf-chip pf-chip-warn">Override</span>}
        </div>
        <div className="pf-module-desc">{module.description}</div>
        {!planned && (
          <div className="pf-module-state">
            {effective ? 'Available' : 'Blocked'}
            {choice === null
              ? ` — following the plan${module.in_plan ? '' : ', which excludes it'}`
              : ' — set here, ignoring the plan'}
          </div>
        )}
      </div>
      <div className="pf-seg" role="group" aria-label={`${module.label} access`}>
        {([
          [null, 'Plan'],
          [true, 'On'],
          [false, 'Off'],
        ] as [Choice, string][]).map(([value, label]) => (
          <button
            key={label}
            type="button"
            className={`pf-seg-btn${choice === value ? ' is-on' : ''}`}
            disabled={disabled || planned}
            aria-pressed={choice === value}
            onClick={() => onChange(value)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
