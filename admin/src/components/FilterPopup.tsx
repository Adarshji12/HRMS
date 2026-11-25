/**
 * A Filters button that opens a small popup of filter fields, like the Leads and Follow-ups lists.
 *
 * Each field applies at once, so there is no Apply to forget. The button shows how many filters
 * differ from the list's starting view, and Reset puts them all back.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconSliders } from './Icons'
import '../styles/leads.css'

export function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="ml-pop-field">
      <span>{label}</span>
      {children}
    </label>
  )
}

export default function FilterPopup({ count, onReset, children }: { count: number; onReset: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)

  /** Drawn on the page body, so no table or card around the button can clip it. */
  function toggle() {
    const r = box.current?.getBoundingClientRect()
    if (r) setAt({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 348)) })
    setOpen((o) => !o)
  }

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { const n = e.target as Node; if (!box.current?.contains(n) && !pop.current?.contains(n)) setOpen(false) }
    const move = () => setOpen(false)
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)
    window.addEventListener('resize', move)
    return () => { document.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc); window.removeEventListener('resize', move) }
  }, [open])

  return (
    <div className="ml-filter" ref={box} style={{ position: 'relative' }}>
      <button type="button" className={`btn${open || count > 0 ? ' is-on' : ''}`} aria-expanded={open} aria-haspopup="dialog" onClick={toggle}>
        <IconSliders size={15} /> Filters
        {count > 0 && <span className="ml-filter-count">{count}</span>}
      </button>
      {open && at && createPortal(
        <div className="crm" style={{ display: 'contents' }}>
        <div ref={pop} className="ml-pop" role="dialog" aria-label="Filters"
             style={{ position: 'fixed', top: at.top, left: at.left, width: 340, zIndex: 1000, maxHeight: `calc(100vh - ${at.top + 12}px)`, overflowY: 'auto' }}>
          {children}
          <button type="button" className="ml-pop-reset" onClick={onReset} disabled={count === 0}>Reset filters</button>
        </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

