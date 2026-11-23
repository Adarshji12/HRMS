/**
 * Per-person view settings: which columns a table shows and in what order, and
 * which fields a form shows, makes mandatory or hides.
 *
 * They are kept in the browser, keyed by the signed-in user, so each person
 * arranges their own screen and nobody's choice changes anybody else's. That also
 * means a setting follows the person's browser, not their account: a second
 * computer starts from the defaults.
 *
 * What a form may hide is limited by what the server requires. A field marked
 * `fixed` (the name and mobile number of a lead) is always shown and always
 * mandatory; its row is shown, greyed, so the reason is visible.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconCog } from './Icons'
import '../styles/viewSettings.css'
import { useAuth } from '../lib/auth'

/* ------------------------------------------------------------------ storage -- */

function useStored<T>(key: string, fallback: T): [T, (next: T | null) => void] {
  const { user } = useAuth()
  const storageKey = `hrms:view:${user?.id ?? 'anon'}:${key}`
  const read = (): T => {
    try {
      const raw = window.localStorage.getItem(storageKey)
      return raw ? (JSON.parse(raw) as T) : fallback
    } catch {
      return fallback
    }
  }
  const [value, setValue] = useState<T>(read)
  // The person can change between renders (sign out, sign in as somebody else).
  useEffect(() => { setValue(read()) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [storageKey])
  function save(next: T | null) {
    try {
      if (next === null) window.localStorage.removeItem(storageKey)
      else window.localStorage.setItem(storageKey, JSON.stringify(next))
    } catch { /* storage blocked: the choice lasts until the page is closed */ }
    setValue(next === null ? fallback : next)
  }
  return [value, save]
}

/* ------------------------------------------------------------------ popover -- */

/** The popover is drawn on the page itself, not inside the button's parent: a
 *  form or dialog that scrolls would clip it, and a table toolbar would push it
 *  off the edge. It is placed under the button, right-aligned, and kept on screen. */
function usePopover(width: number) {
  const [open, setOpenState] = useState(false)
  const [style, setStyle] = useState<CSSProperties>({})
  const ref = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  function setOpen(next: boolean) {
    if (next && ref.current) {
      const box = ref.current.getBoundingClientRect()
      const w = Math.min(width, window.innerWidth - 16)
      const top = box.bottom + 8
      setStyle({
        top,
        left: Math.max(8, Math.min(box.right - w, window.innerWidth - w - 8)),
        width: w,
        maxHeight: Math.min(480, Math.max(240, window.innerHeight - top - 12)),
      })
    }
    setOpenState(next)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const inside = (el: HTMLElement | null) => el?.contains(e.target as Node)
      if (!inside(ref.current) && !inside(popRef.current)) setOpenState(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenState(false) }
    const close = () => setOpenState(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const render = (className: string, label: string, children: ReactNode) =>
    open
      ? createPortal(
          <div className={className} role="dialog" aria-label={label} ref={popRef} style={style}>
            {children}
          </div>,
          document.body,
        )
      : null
  return { open, setOpen, ref, render }
}

const Grip = () => (
  <span className="vw-grip" aria-hidden>
    <i /><i /><i /><i /><i /><i />
  </span>
)

/* ------------------------------------------------------------------ columns -- */

export interface ColumnDef {
  key: string
  label: string
  /** Always shown (the row's identity); can still be dragged. */
  locked?: boolean
  /** Shown until the person hides it. */
  initial?: boolean
}

interface ColumnPref { order: string[]; hidden: string[] }

/** The saved choice laid over today's column list: a column added since the
 *  choice was saved appears at the end, one that no longer exists is dropped. */
function settle(defs: ColumnDef[], pref: ColumnPref | null) {
  const known = new Set(defs.map((d) => d.key))
  const order = pref ? pref.order.filter((k) => known.has(k)) : []
  for (const d of defs) if (!order.includes(d.key)) order.push(d.key)
  const hidden = new Set(
    pref ? pref.hidden.filter((k) => known.has(k)) : defs.filter((d) => d.initial === false).map((d) => d.key),
  )
  // A column added after the choice was saved follows its own default.
  if (pref) for (const d of defs) if (!pref.order.includes(d.key) && d.initial === false) hidden.add(d.key)
  for (const d of defs) if (d.locked) hidden.delete(d.key)
  return { order, hidden }
}

/** The columns to draw, in order. */
export function useColumns(tableKey: string, defs: ColumnDef[]) {
  const [pref, save] = useStored<ColumnPref | null>(`cols:${tableKey}`, null)
  const { order, hidden } = settle(defs, pref)
  const byKey = new Map(defs.map((d) => [d.key, d]))
  const visible = order.filter((k) => !hidden.has(k)).map((k) => byKey.get(k)!)
  return {
    visible,
    pref: { order, hidden: [...hidden] },
    save: (next: ColumnPref) => save(next),
    reset: () => save(null),
  }
}

export function ColumnSettings({
  defs, order, hidden, onSave, onReset,
}: {
  defs: ColumnDef[]
  order: string[]
  hidden: string[]
  onSave: (pref: ColumnPref) => void
  onReset: () => void
}) {
  const { open, setOpen, ref, render } = usePopover(340)
  const [list, setList] = useState(order)
  const [off, setOff] = useState(new Set(hidden))
  const [dragging, setDragging] = useState<number | null>(null)
  const byKey = new Map(defs.map((d) => [d.key, d]))

  function openPopover() {
    setList(order)
    setOff(new Set(hidden))
    setOpen(!open)
  }
  const defaultState = () => {
    const base = settle(defs, null)
    setList(base.order)
    setOff(new Set(base.hidden))
  }
  function drop(to: number) {
    if (dragging === null || dragging === to) return
    const next = [...list]
    const [moved] = next.splice(dragging, 1)
    next.splice(to, 0, moved)
    setList(next)
    setDragging(null)
  }

  const [spinning, setSpinning] = useState(false)
  function refresh() {
    window.dispatchEvent(new Event('app:refresh'))
    setSpinning(true)
    window.setTimeout(() => setSpinning(false), 700)
  }

  return (
    <>
    <button type="button" className={`btn vw-btn vw-refresh${spinning ? ' is-spinning' : ''}`} onClick={refresh}
            aria-label="Refresh" title="Refresh">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4" />
      </svg>
    </button>
    <div className="vw-wrap" ref={ref}>
      <button type="button" className={`btn vw-btn${open ? ' is-open' : ''}`} aria-haspopup="dialog" aria-expanded={open}
              onClick={openPopover}>
        <IconCog size={14} /> Columns
      </button>
      {render('vw-pop', 'Show, hide and reorder columns', <>
          <div className="vw-head">
            <span>Show / hide &amp; reorder columns</span>
            <button type="button" className="vw-link" onClick={defaultState}>Reset</button>
          </div>
          <ul className="vw-list">
            {list.map((key, index) => {
              const def = byKey.get(key)
              if (!def) return null
              return (
                <li key={key} className={dragging === index ? 'is-dragging' : undefined} draggable
                    onDragStart={() => setDragging(index)} onDragEnd={() => setDragging(null)}
                    onDragOver={(e) => e.preventDefault()} onDrop={() => drop(index)}>
                  <Grip />
                  <label>
                    <input type="checkbox" checked={def.locked || !off.has(key)} disabled={def.locked}
                           onChange={(e) => {
                             const next = new Set(off)
                             if (e.target.checked) next.delete(key)
                             else next.add(key)
                             setOff(next)
                           }} />
                    {def.label}
                  </label>
                </li>
              )
            })}
          </ul>
          <div className="vw-foot">
            <button type="button" className="vw-link" onClick={() => { onReset(); setOpen(false) }}>Default</button>
            <button type="button" className="btn btn-primary btn-sm"
                    onClick={() => { onSave({ order: list, hidden: [...off] }); setOpen(false) }}>
              Save
            </button>
          </div>
      </>)}
    </div>
    </>
  )
}

/* ------------------------------------------------------------------- fields -- */

export type FieldMode = 'show' | 'mandatory' | 'hide'

export interface FieldSection { id: string; label: string }

export interface FieldDef {
  key: string
  label: string
  /** Which part of the form it sits in; order is arranged within a part. */
  section: string
  /** The server needs it: always shown, always mandatory (it can still be moved). */
  fixed?: boolean
  /** Starts mandatory rather than merely shown. */
  initial?: FieldMode
  /** Cannot be made mandatory: a tick box or a worked-out figure is never empty. */
  optionalOnly?: boolean
}

export interface FieldPref { modes: Record<string, FieldMode>; order: string[] }

/** The saved order laid over today's fields: a field added since appears at the
 *  end of its part, one that no longer exists is dropped. */
function settleOrder(defs: FieldDef[], saved: string[] | undefined): string[] {
  const known = new Set(defs.map((d) => d.key))
  const order = (saved ?? []).filter((k) => known.has(k))
  for (const d of defs) if (!order.includes(d.key)) order.push(d.key)
  return order
}

/** How each field of a form is treated for this person: shown, mandatory or
 *  hidden, and where it sits within its part of the form. */
export function useFieldModes(formKey: string, defs: FieldDef[]) {
  const [saved, save] = useStored<FieldPref | null>(`fields:${formKey}`, null)
  const modes: Record<string, FieldMode> = {}
  for (const d of defs) {
    const chosen = saved?.modes?.[d.key] ?? d.initial ?? 'show'
    modes[d.key] = d.fixed ? 'mandatory' : d.optionalOnly && chosen === 'mandatory' ? 'show' : chosen
  }
  const order = settleOrder(defs, saved?.order)
  return {
    mode: (key: string): FieldMode => modes[key] ?? 'show',
    /** The keys of one part of the form, in the order this person arranged them. */
    orderOf: (section: string): string[] =>
      order.filter((k) => defs.find((d) => d.key === k)?.section === section),
    modes,
    order,
    save: (next: FieldPref) => save(next),
    reset: () => save(null),
  }
}

/** The form's field settings: a button, and a drawer from the right with Show /
 *  Hide and Arrange. Nothing changes on the form until Save. */
export function FieldSettings({
  defs, sections, modes, order, onSave, onReset, title = 'Form Fields',
}: {
  defs: FieldDef[]
  sections: FieldSection[]
  modes: Record<string, FieldMode>
  order: string[]
  onSave: (pref: FieldPref) => void
  onReset: () => void
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'show' | 'arrange'>('show')
  const [draft, setDraft] = useState(modes)
  const [list, setList] = useState(order)
  const [drag, setDrag] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const byKey = new Map(defs.map((d) => [d.key, d]))
  const standardOrder = defs.map((d) => d.key)
  const needle = search.trim().toLowerCase()

  useEffect(() => {
    if (!open) return
    // Captured and stopped: Escape closes the drawer only, not the dialog under it.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  /** Move a field within its own part: onto another field's place, or by one step. */
  function move(key: string, toKey: string | null, step = 0) {
    const section = byKey.get(key)?.section
    const part = list.filter((k) => byKey.get(k)?.section === section)
    const from = part.indexOf(key)
    const to = toKey ? part.indexOf(toKey) : from + step
    if (from < 0 || to < 0 || to >= part.length || to === from) return
    part.splice(to, 0, part.splice(from, 1)[0])
    // Put the part back where its fields were, leaving the other parts alone.
    let i = 0
    setList(list.map((k) => (byKey.get(k)?.section === section ? part[i++] : k)))
  }

  const drawer = open
    ? createPortal(
        <div className="vw-drawer-wrap">
          <div className="vw-drawer-backdrop" onMouseDown={() => setOpen(false)} />
          <aside className="vw-drawer" role="dialog" aria-label={title}>
            <header className="vw-drawer-head">
              <h3><IconCog size={16} /> {title}</h3>
              <button type="button" className="vw-drawer-x" aria-label="Close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="vw-drawer-search">
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
                     placeholder="Search here…" aria-label="Search fields" />
            </div>

            <div className="vw-drawer-body">
              <div className="vw-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={tab === 'show'} className={tab === 'show' ? 'is-on' : undefined}
                        onClick={() => setTab('show')}>Show / Hide</button>
                <button type="button" role="tab" aria-selected={tab === 'arrange'} className={tab === 'arrange' ? 'is-on' : undefined}
                        onClick={() => setTab('arrange')}>Arrange</button>
              </div>

              {tab === 'show' ? (
                <>
                  <p className="vw-note">
                    Which fields the form shows, and which it insists on. Full name and mobile number
                    can be made neither optional nor hidden.
                  </p>
                  {sections.map((sec) => {
                    const rows = defs.filter((d) => d.section === sec.id && (!needle || d.label.toLowerCase().includes(needle)))
                    if (rows.length === 0) return null
                    return (
                      <section key={sec.id}>
                        <h4 className="vw-sec">{sec.label}</h4>
                        {rows.map((d) => (
                          <div className="vw-row" key={d.key}>
                            <span className="vw-field-name">{d.label}</span>
                            <div className="vw-seg" role="radiogroup" aria-label={d.label}>
                              {(['show', 'mandatory', 'hide'] as FieldMode[]).map((m) => {
                                const on = (d.fixed ? 'mandatory' : draft[d.key]) === m
                                return (
                                  <button key={m} type="button" role="radio" aria-checked={on} disabled={d.fixed || (d.optionalOnly && m === 'mandatory')}
                                          className={on ? 'is-on' : undefined}
                                          title={d.fixed ? 'Always needed, so it cannot be hidden or made optional.' : undefined}
                                          onClick={() => setDraft({ ...draft, [d.key]: m })}>
                                    {m === 'show' ? 'Show' : m === 'mandatory' ? 'Mandatory' : 'Hide'}
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        ))}
                      </section>
                    )
                  })}
                </>
              ) : (
                <>
                  <div className="vw-arrange-head">
                    <p className="vw-note">
                      Which field comes first in each part of the form, and the order Tab follows.
                      Drag a row, or use its arrows.
                    </p>
                    <button type="button" className="vw-link" onClick={() => setList(standardOrder)}>Standard order</button>
                  </div>
                  <div className="vw-cols">
                    {sections.map((sec) => {
                      const part = list.filter((k) => byKey.get(k)?.section === sec.id)
                      return (
                        <div className="vw-col" key={sec.id}>
                          <h4 className="vw-sec">{sec.label} <span className="vw-count">{part.length}</span></h4>
                          {part.map((key, i) => {
                            const d = byKey.get(key)!
                            return (
                              <div key={key} className={`vw-card${drag === key ? ' is-dragging' : ''}`} draggable
                                   onDragStart={() => setDrag(key)} onDragEnd={() => setDrag(null)}
                                   onDragOver={(e) => e.preventDefault()}
                                   onDrop={() => { if (drag && drag !== key) move(drag, key); setDrag(null) }}>
                                <Grip />
                                <span className="vw-idx">{i + 1}</span>
                                <span className="vw-card-name">
                                  {d.label}
                                  {d.fixed && <em className="vw-badge">Always</em>}
                                  {!d.fixed && draft[key] === 'hide' && <em className="vw-badge is-muted">Hidden</em>}
                                </span>
                                <button type="button" className="vw-arrow" aria-label={`Move ${d.label} up`}
                                        disabled={i === 0} onClick={() => move(key, null, -1)}>↑</button>
                                <button type="button" className="vw-arrow" aria-label={`Move ${d.label} down`}
                                        disabled={i === part.length - 1} onClick={() => move(key, null, 1)}>↓</button>
                              </div>
                            )
                          })}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </div>

            <footer className="vw-drawer-foot">
              <button type="button" className="vw-link" onClick={() => { onReset(); setOpen(false) }}>Default</button>
              <span className="vw-spacer" />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn btn-primary btn-sm"
                      onClick={() => { onSave({ modes: draft, order: list }); setOpen(false) }}>
                Save
              </button>
            </footer>
          </aside>
        </div>,
        document.body,
      )
    : null

  return (
    <>
      <button type="button" className={`btn btn-sm vw-btn${open ? ' is-open' : ''}`} aria-haspopup="dialog" aria-expanded={open}
              onClick={() => { setDraft(modes); setList(order); setTab('show'); setSearch(''); setOpen(true) }}>
        <IconCog size={14} /> Settings
      </button>
      {drawer}
    </>
  )
}
