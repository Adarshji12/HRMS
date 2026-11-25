/**
 * Print and Share icons for one row of a list: they sit beside Edit and Delete
 * in the Actions column and send that record's details — printed as a small
 * card, or shared through WhatsApp, email, the clipboard or the device's share sheet.
 *
 * The menu is drawn on the page body, not inside the table, so the table's own
 * scrolling never clips it.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconPrinter } from './Icons'
import type { IoColumn } from './ImportExport'

const svg = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

const ShareGlyph = ({ size = 14 }: { size?: number }) => (
  <svg {...svg} width={size} height={size}><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.6 10.6l6.8-4M8.6 13.4l6.8 4" /></svg>
)
const CopyGlyph = () => <svg {...svg}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>
const MailGlyph = () => <svg {...svg}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
const ChatGlyph = () => <svg {...svg}><path d="M21 12a8 8 0 0 1-11.7 7.1L4 20.5l1.5-4.9A8 8 0 1 1 21 12Z" /></svg>
const MoreGlyph = () => <svg {...svg}><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>

const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const NL = String.fromCharCode(10)

export default function RowShare<T>({ name, title, columns, row }: {
  /** What a row is called, e.g. "walk-in customer". */
  name: string
  /** The row's own heading, e.g. the customer's name. */
  title: string
  columns: IoColumn<T>[]
  row: T
}) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const [done, setDone] = useState('')
  const button = useRef<HTMLButtonElement>(null)

  const facts = columns
    .map((c) => [c.label, c.get(row)] as const)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
  const text = (limit: number) => {
    const out = `${title}${NL}${facts.map(([k, v]) => `${k}: ${v}`).join(NL)}`
    return out.length > limit ? `${out.slice(0, limit)}…` : out
  }

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); window.removeEventListener('keydown', key) }
  }, [open])
  useEffect(() => {
    if (!done) return
    const id = setTimeout(() => setDone(''), 2200)
    return () => clearTimeout(id)
  }, [done])

  function toggle() {
    const r = button.current?.getBoundingClientRect()
    if (r) setAt({ top: r.bottom + 6, left: Math.max(8, Math.min(r.right - 210, window.innerWidth - 218)) })
    setOpen((v) => !v)
  }

  function print() {
    const w = window.open('', '_blank', 'width=720,height=640')
    if (!w) { setDone('Allow pop-ups to print'); return }
    const rows = facts.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
      <style>body{font:13px 'Segoe UI',Arial,sans-serif;margin:28px;color:#111}small{color:#667;text-transform:uppercase;letter-spacing:.06em}
      h1{font-size:20px;margin:2px 0 14px}table{border-collapse:collapse;width:100%}th,td{padding:8px 10px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}
      th{width:34%;color:#556;font-weight:600}</style></head><body><small>${esc(name)}</small><h1>${esc(title)}</h1><table>${rows}</table></body></html>`)
    w.document.close()
    w.focus()
    setTimeout(() => w.print(), 250)
  }

  async function share(how: 'copy' | 'whatsapp' | 'email' | 'device') {
    setOpen(false)
    if (how === 'copy') {
      try { await navigator.clipboard.writeText(text(100000)); setDone('Copied') } catch { setDone('Could not copy') }
    } else if (how === 'whatsapp') {
      window.open(`https://wa.me/?text=${encodeURIComponent(text(3000))}`, '_blank', 'noopener')
    } else if (how === 'email') {
      window.location.href = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(text(1800))}`
    } else {
      try { await navigator.share({ title, text: text(3000) }) } catch { /* closed without sharing */ }
    }
  }

  const items: Array<['copy' | 'whatsapp' | 'email' | 'device', string, string, JSX.Element]> = [
    ['whatsapp', 'WhatsApp', 'Send the details in a chat', <ChatGlyph key="w" />],
    ['email', 'Email', 'Open your mail app', <MailGlyph key="e" />],
    ['copy', 'Copy details', 'Paste them anywhere', <CopyGlyph key="c" />],
    ...(typeof navigator !== 'undefined' && 'share' in navigator ? [['device', 'More apps…', 'Use this device’s share sheet', <MoreGlyph key="m" />] as ['device', string, string, JSX.Element]] : []),
  ]

  return (
    <>
      <button type="button" className="crm-icon-btn" onClick={print} title={`Print ${title}`} aria-label={`Print ${title}`}><IconPrinter size={14} /></button>
      <button ref={button} type="button" className="crm-icon-btn" onClick={toggle} title={`Share ${title}`} aria-label={`Share ${title}`} aria-expanded={open}><ShareGlyph /></button>
      {done && <span className="muted-sm" role="status" style={{ whiteSpace: 'nowrap' }}>{done}</span>}
      {open && at && createPortal(
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 999 }} />
          <div role="menu" aria-label={`Share ${title}`} style={{
            position: 'fixed', top: at.top, left: at.left, zIndex: 1000, width: 210, padding: 6, borderRadius: 14,
            background: 'var(--surface-1, #fff)', border: '1px solid var(--border, #e2e8f0)', boxShadow: '0 16px 40px rgba(15,23,42,.22)',
          }}>
            <div style={{ padding: '6px 10px 8px', fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted, #64748b)' }}>Share</div>
            {items.map(([k, label, hint, icon]) => (
              <button key={k} type="button" role="menuitem" onClick={() => void share(k)} className="rs-item">
                <span className="rs-icon">{icon}</span>
                <span><b>{label}</b><small>{hint}</small></span>
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  )
}
