import { useState } from 'react'
import { Dialog } from './parts'
import { ErrorNote } from '../../components/ui'
import { crm, crmError, type Quotation } from './api'

/**
 * "Send by email", opened by Save & Send on a quotation.
 *
 * The customer's address is pre-filled from the quotation. The email is sent from the company's own mail connector
 * (Settings > Email setup). The body is the full quotation as in Preview, under the short message written here.
 */
const NL = String.fromCharCode(10)

function defaultMessage(q: Quotation): string {
  const who = q.customer_name || q.company || 'there'
  return `Hello ${who},${NL}${NL}Please find our quotation ${q.number} below. Let us know if you have any questions. Thank you.`
}

const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())

export default function QuotationEmail({ quotation, onClose }: { quotation: Quotation; onClose: () => void }) {
  const [to, setTo] = useState(quotation.email ?? '')
  const [cc, setCc] = useState('')
  const [subject, setSubject] = useState(`Quotation ${quotation.number}`)
  const [message, setMessage] = useState(defaultMessage(quotation))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const who = quotation.customer_name || quotation.company
  const ready = looksLikeEmail(to) && (!cc.trim() || looksLikeEmail(cc)) && subject.trim() !== '' && message.trim() !== ''

  async function send() {
    setBusy(true)
    setError(null)
    try {
      await crm.emailQuotation(quotation.id, { to: to.trim(), cc: cc.trim() || null, subject: subject.trim(), message })
      setDone(true)
    } catch (err) {
      setError(crmError(err, 'The email could not be sent'))
    } finally {
      setBusy(false)
    }
  }

  const label = { display: 'grid', gap: 6, fontSize: 11.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--text-muted)' } as const
  const plain = { fontWeight: 400, textTransform: 'none', letterSpacing: 0 } as const

  return (
    <Dialog title="Send by email" subtitle={`${quotation.number}${who ? ` · ${who}` : ''}`} medium onClose={onClose}
            footer={<>
              <button className="btn" onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>
              {!done && <button className="btn btn-primary" disabled={!ready || busy} onClick={() => void send()}>{busy ? 'Sending...' : 'Send email'}</button>}
            </>}>
      <div style={{ display: 'grid', gap: 14, padding: '4px 24px 20px' }}>
        {error && <ErrorNote>{error}</ErrorNote>}
        {done && <div className="notice" role="status">Sent to {to.trim()}.</div>}
        <label style={label}>To
          <input type="email" value={to} autoFocus placeholder="customer@company.com" style={{ ...plain, height: 40 }} onChange={(e) => setTo(e.target.value)} />
          {to.trim() !== '' && !looksLikeEmail(to) && <span style={{ ...plain, color: 'var(--danger, #d92d50)', fontWeight: 500 }}>That is not an email address yet.</span>}
        </label>
        <label style={label}>Copy to (optional)
          <input type="email" value={cc} placeholder="you@company.com" style={{ ...plain, height: 40 }} onChange={(e) => setCc(e.target.value)} />
        </label>
        <label style={label}>Subject
          <input value={subject} maxLength={200} style={{ ...plain, height: 40 }} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <label style={label}>Message
          <textarea rows={7} value={message} style={plain} onChange={(e) => setMessage(e.target.value)} />
        </label>
        <p className="muted-sm" style={{ margin: 0 }}>The quotation is saved and marked Sent. The email shows the full quotation, as in Preview, under this message.</p>
      </div>
    </Dialog>
  )
}
