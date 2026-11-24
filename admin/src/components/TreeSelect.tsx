/**
 * A dropdown for a tree: section headings, rows indented by level, a search box.
 *
 * A native <select> can only fake indentation with spaces, and the open list is
 * drawn by the operating system, so a tree in it reads as a flat list. This draws
 * the list itself.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

export type TreeOption =
  | { header: string }
  | { key: string; label: string; depth?: number; bold?: boolean }

export default function TreeSelect({ value, options, onChange, placeholder = 'Choose', searchPlaceholder = 'Search…', disabled, autoFocus }: {
  /** The `key` of the chosen option. */
  value: string
  options: TreeOption[]
  onChange: (key: string) => void
  placeholder?: string
  searchPlaceholder?: string
  disabled?: boolean
  autoFocus?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQ('')
    window.setTimeout(() => search.current?.focus(), 0)
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc, true) }
  }, [open])

  const chosen = options.find((o): o is Extract<TreeOption, { key: string }> => 'key' in o && o.key === value)
  const needle = q.trim().toLowerCase()
  const shown = useMemo(() => {
    if (!needle) return options
    // While searching, show only the matches — a heading with nothing under it is noise.
    return options.filter((o) => 'key' in o && o.label.toLowerCase().includes(needle))
  }, [options, needle])

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <button type="button" disabled={disabled} autoFocus={autoFocus} aria-haspopup="listbox" aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              style={{
                width: '100%', height: 'var(--control-h, 40px)', padding: '0 30px 0 var(--control-px, 12px)', textAlign: 'left',
                border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm, 8px)', background: 'var(--surface-1)',
                color: chosen ? 'var(--text-primary)' : 'var(--text-muted)', font: 'inherit', fontSize: 13.5, cursor: disabled ? 'not-allowed' : 'pointer',
                backgroundImage: 'var(--caret)', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 11px center', backgroundSize: '12px 8px',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
        {chosen ? chosen.label : placeholder}
      </button>
      {open && (
        <div role="listbox" style={{
          position: 'absolute', zIndex: 60, left: 0, right: 0, top: 'calc(100% + 4px)', maxHeight: 320, display: 'flex', flexDirection: 'column',
          background: 'var(--surface-1)', border: '1px solid var(--border-strong)', borderRadius: 10, boxShadow: 'var(--shadow-lg, 0 12px 32px rgba(0,0,0,.18))',
        }}>
          <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder} aria-label="Search"
                 style={{ margin: 8, width: 'auto', height: 34, fontSize: 13 }} />
          <div style={{ overflowY: 'auto', padding: '0 6px 6px' }}>
            {shown.length === 0 && <p className="muted-sm" style={{ margin: 10 }}>Nothing matches.</p>}
            {shown.map((o, i) => 'header' in o ? (
              <div key={`h${i}`} style={{ padding: '10px 10px 4px', fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                {o.header}
              </div>
            ) : (
              <button key={`${o.key}-${i}`} type="button" role="option" aria-selected={o.key === value}
                      onClick={() => { onChange(o.key); setOpen(false) }}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left', border: 0, borderRadius: 6, cursor: 'pointer', font: 'inherit', fontSize: 13.5,
                        padding: `7px 10px 7px ${10 + (needle ? 0 : (o.depth ?? 0) * 18)}px`, fontWeight: o.bold ? 700 : 400,
                        background: o.key === value ? 'var(--brand-soft)' : 'transparent', color: o.key === value ? 'var(--brand)' : 'var(--text-primary)',
                      }}
                      onMouseEnter={(e) => { if (o.key !== value) e.currentTarget.style.background = 'var(--surface-2)' }}
                      onMouseLeave={(e) => { if (o.key !== value) e.currentTarget.style.background = 'transparent' }}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

