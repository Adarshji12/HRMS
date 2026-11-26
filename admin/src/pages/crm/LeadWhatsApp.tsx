import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { dateTime } from '../../lib/format'
import { whatsappLink, type Lead } from './api'

/**
 * The WhatsApp button on a lead's row.
 *
 * It offers the two things somebody means by it: share this lead's details (opens WhatsApp with the details already
 * written, to be sent to whoever they pick), or message the lead on their own number. The details message is built from
 * what is on the record, leaving out anything empty.
 */

const NL = String.fromCharCode(10)

export function leadDetailsText(lead: Lead): string {
  const place = [lead.address, lead.city_name, lead.state_name].filter(Boolean).join(', ') + (lead.pincode ? ` - ${lead.pincode}` : '')
  const rows: Array<[string, string | null | undefined]> = [
    ['Company', lead.company],
    ['Mobile', lead.mobile],
    ['WhatsApp', lead.whatsapp && lead.whatsapp !== lead.mobile ? lead.whatsapp : null],
    ['Email', lead.email],
    ['Status', lead.status_name],
    ['Source', lead.source_name],
    ['Industry', lead.industry_name],
    ['Product', lead.product_name],
    ['Value', lead.value],
    ['Address', place.trim() === '' || place.trim() === '-' ? null : place],
    ['Next follow-up', lead.next_follow_up_at ? dateTime(lead.next_follow_up_at) : null],
    ['Assigned to', lead.owner_name],
    ['Notes', lead.notes],
  ]
  const body = rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(NL)
  return `Lead: ${lead.name}${lead.code ? ` (${lead.code})` : ''}${NL}${body}`
}

const Glyph = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 21l2.2-5.2A8.5 8.5 0 1 1 21 11.5Z" />
    <path d="M8.8 9.2c.3-.7.6-.7.9-.7h.6c.2 0 .4 0 .6.5l.7 1.6c.1.2 0 .4-.1.6l-.4.5c-.1.2-.2.3 0 .6a6 6 0 0 0 2.6 2.2c.3.1.4 0 .6-.1l.5-.6c.2-.2.3-.2.6-.1l1.6.8c.3.1.4.3.4.5a2 2 0 0 1-1.5 1.7 4 4 0 0 1-2.6-.4 9.6 9.6 0 0 1-4.4-4.3c-.5-1-.7-2-.1-2.8Z" />
  </svg>
)

export default function LeadWhatsApp({ lead }: { lead: Lead }) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const chat = whatsappLink(lead.whatsapp ?? lead.mobile)

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); window.removeEventListener('keydown', key) }
  }, [open])

  function toggle() {
    const r = button.current?.getBoundingClientRect()
    if (r) setAt({ top: r.bottom + 6, left: Math.max(8, Math.min(r.right - 230, window.innerWidth - 238)) })
    setOpen((v) => !v)
  }

  function shareDetails() {
    setOpen(false)
    // No number in the link: WhatsApp asks who to send it to.
    window.open(`https://wa.me/?text=${encodeURIComponent(leadDetailsText(lead))}`, '_blank', 'noopener')
  }

  function messageLead() {
    setOpen(false)
    if (chat) window.open(chat, '_blank', 'noopener')
  }

  return (
    <>
      <button ref={button} type="button" className="crm-icon-btn crm-icon-wa" onClick={toggle} aria-haspopup="menu" aria-expanded={open}
              title={`WhatsApp - share ${lead.name}'s details or message them`} aria-label={`WhatsApp for ${lead.name}`}>
        <Glyph />
      </button>
      {open && at && createPortal(
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 999 }} />
          <div role="menu" aria-label={`WhatsApp ${lead.name}`} style={{
            position: 'fixed', top: at.top, left: at.left, zIndex: 1000, width: 230, padding: 6, borderRadius: 14,
            background: 'var(--surface-1, #fff)', border: '1px solid var(--border, #e2e8f0)', boxShadow: '0 16px 40px rgba(15,23,42,.22)',
          }}>
            <button type="button" role="menuitem" className="rs-item" onClick={shareDetails}>
              <span className="rs-icon"><Glyph /></span>
              <span><b>Share lead details</b><small>Send this lead's details to anyone</small></span>
            </button>
            <button type="button" role="menuitem" className="rs-item" onClick={messageLead} disabled={!chat} style={chat ? undefined : { opacity: 0.5 }}>
              <span className="rs-icon"><Glyph /></span>
              <span><b>Message {lead.name.split(' ')[0]}</b><small>{chat ? 'Open a chat with this lead' : 'No valid WhatsApp number'}</small></span>
            </button>
          </div>
        </>,
        document.body,
      )}
    </>
  )
}
