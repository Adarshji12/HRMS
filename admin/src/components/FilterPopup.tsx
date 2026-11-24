/**
 * A Filters button that opens a small popup of filter fields, like the Leads and Follow-ups lists.
 *
 * Each field applies at once, so there is no Apply to forget. The button shows how many filters
 * differ from the list's starting view, and Reset puts them all back.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
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

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc) }
  }, [open])

  return (
    <div className="ml-filter" ref={box} style={{ position: 'relative' }}>
      <button type="button" className={`btn${open || count > 0 ? ' is-on' : ''}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <IconSliders size={15} /> Filters
        {count > 0 && <span className="ml-filter-count">{count}</span>}
      </button>
      {open && (
        <div className="ml-pop" role="dialog" aria-label="Filters" style={{ left: 0, width: 340 }}>
          {children}
          <button type="button" className="ml-pop-reset" onClick={onReset} disabled={count === 0}>Reset filters</button>
        </div>
      )}
    </div>
  )
}

