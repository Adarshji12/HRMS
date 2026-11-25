/* Write an email to a lead from the leads list.

   The address and name come off the row that was clicked, so nothing is fetched
   to open the dialog. The address stays editable: a lead with none on file can
   still be written to, and the dialog says so rather than leaving a blank box.
   Sending goes through the workspace's mail connector on the server; the dialog
   only closes once the server has accepted the message. */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ErrorNote } from '../../components/ui'
import { ApiError } from '../../lib/api'
import { crm, crmError, type Lead } from './api'
import { Dialog, Field } from './parts'

const ADDRESS = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]{2,}$/

/** "a@x.com, b@y.com; c@z.com" → the addresses, in order, without repeats. */
function splitAddresses(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((part) => part.trim()).filter(Boolean))]
}

export function LeadEmailDialog({
  lead, onClose, onSent,
}: {
  lead: Lead
  onClose: () => void
  onSent: (message: string) => void
}) {
  const [to, setTo] = useState(lead.email ?? '')
  const [name, setName] = useState(lead.name)
  const [subject, setSubject] = useState('')
  const [bcc, setBcc] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notSetUp, setNotSetUp] = useState(false)

  const toBad = to.trim() !== '' && !ADDRESS.test(to.trim())
  const bccList = splitAddresses(bcc)
  const badBcc = bccList.find((address) => !ADDRESS.test(address))
  const ready = ADDRESS.test(to.trim()) && subject.trim() !== '' && body.trim() !== '' && !badBcc

  async function send() {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    setNotSetUp(false)
    try {
      await crm.emailLead(lead.id, {
        to: to.trim(), name: name.trim() || null, subject: subject.trim(), body: body.trim(), bcc: bccList,
      })
      onSent(`Email sent to ${to.trim()}.`)
    } catch (err) {
      setNotSetUp(err instanceof ApiError && err.status === 409)
      setError(crmError(err, 'The email could not be sent'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Send email"
      subtitle={`To ${lead.name}${lead.code ? ` · ${lead.code}` : ''}`}
      onClose={() => { if (!busy) onClose() }}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={send} disabled={!ready || busy}>
            {busy ? 'Sending…' : 'Send Email'}
          </button>
        </>
      }
    >
      <div className="crm-form">
        {error && (
          <div className="crm-form-wide"><ErrorNote>{error}</ErrorNote>
            {notSetUp && <p className="crm-sub"><Link to="/settings/email">Open Email setup</Link> (workspace owner only)</p>}
          </div>
        )}
        <Field label="Name">
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field
          label="To"
          required
          hint={!lead.email && !to.trim()
            ? 'This lead has no email address on file. Enter one to send.'
            : toBad ? <span style={{ color: 'var(--danger, #b42318)' }}>Enter a valid email address</span> : undefined}
        >
          <input type="email" value={to} placeholder="name@company.com"
                 onChange={(event) => setTo(event.target.value)} />
        </Field>
        <Field label="Subject" wide required>
          <input value={subject} maxLength={200} autoFocus onChange={(event) => setSubject(event.target.value)} />
        </Field>
        <Field
          label="BCC"
          wide
          hint={badBcc
            ? <span style={{ color: 'var(--danger, #b42318)' }}>{badBcc} is not a valid email address</span>
            : 'Optional. Separate several addresses with a comma.'}
        >
          <input value={bcc} placeholder="manager@company.com, accounts@company.com"
                 onChange={(event) => setBcc(event.target.value)} />
        </Field>
        <Field label="Message" wide required>
          <textarea rows={9} value={body} onChange={(event) => setBody(event.target.value)}
                    placeholder={`Hi ${name.trim().split(' ')[0] || 'there'},`} />
        </Field>
      </div>
    </Dialog>
  )
}
