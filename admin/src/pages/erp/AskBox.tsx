import { useEffect, useRef, type ReactNode } from 'react'
import { IconCheck } from '../../components/Icons'
import '../../styles/salebill.css'

/** A small yes / no box: Y or Enter says yes, N or Esc says no. */
export default function AskBox({ title, sub, yes, onYes, onNo, busy, error, children }: {
  title: string; sub?: string; yes: string; onYes: () => void; onNo: () => void; busy?: boolean; error?: string | null; children?: ReactNode
}) {
  const yesRef = useRef<HTMLButtonElement>(null)
  useEffect(() => yesRef.current?.focus(), [])
  return (
    <div className="sb-ask-back" role="dialog" aria-modal="true" aria-label={title}
         onKeyDown={(e) => {
           e.stopPropagation()
           if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); if (!busy) onYes() }
           else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') { e.preventDefault(); onNo() }
         }}>
      <div className="sb-ask">
        <div className="sb-ask-head"><IconCheck size={16} /> <b>{title}</b>{sub && <small>{sub}</small>}</div>
        {children && <div className="sb-ask-body">{children}</div>}
        {error && <p className="error" style={{ margin: '0 18px' }}>{error}</p>}
        <div className="sb-ask-foot">
          <button type="button" ref={yesRef} className="btn btn-primary" disabled={busy} onClick={onYes}>{busy ? 'Saving…' : yes}</button>
          <button type="button" className="btn" onClick={onNo}>No</button>
        </div>
      </div>
    </div>
  )
}
