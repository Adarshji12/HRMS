import { useEffect, useState, type FormEvent } from 'react'
import { ErrorNote } from '../../components/ui'
import type { CompanyDetail } from '../../lib/platformApi'

/**
 * Confirm a permanent company deletion.
 *
 * Suspending is one click, because it is reversible. This is not, so the
 * workspace slug has to be typed back — the standard pattern, and the reason it
 * is standard is that it makes the operator read the name of the thing they are
 * about to erase rather than click through a dialog they have seen before.
 *
 * The counts are shown for the same reason: "3 employees, 12,400 screenshots"
 * is the sentence that stops the wrong deletion.
 */
export default function CompanyDelete({
  company,
  onClose,
  onConfirm,
}: {
  company: CompanyDetail
  onClose: () => void
  onConfirm: (confirmSlug: string, reason: string) => Promise<void>
}) {
  const [typed, setTyped] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const matches = typed.trim().toLowerCase() === company.slug.toLowerCase()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!matches) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm(typed.trim(), reason.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the company')
      setBusy(false)
    }
  }

  return (
    <div className="hx-backdrop" onMouseDown={onClose}>
      <form className="hx-dialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="hx-dialog-head">
          <h2 className="hx-dialog-title">Delete {company.name}</h2>
          <p className="muted-sm">This cannot be undone.</p>
        </div>

        <div className="hx-list" style={{ padding: '14px 20px' }}>
          {error && <div style={{ marginBottom: 12 }}><ErrorNote>{error}</ErrorNote></div>}

          <div className="pf-warn-box" style={{ marginTop: 0 }}>
            <b>Everything below is erased permanently.</b>
            <ul className="pf-features" style={{ marginTop: 8 }}>
              <li>{company.usage.seats_used} active employee account(s), and every deactivated one</li>
              <li>{company.usage.screenshots.toLocaleString('en-IN')} screenshots, files included</li>
              <li>All activity, timesheets, projects and reports</li>
              <li>{company.subscriptions.length} subscription record(s) and {company.payments.length} payment record(s)</li>
            </ul>
            <div className="pf-muted" style={{ marginTop: 8 }}>
              If you only need to stop them using the product, suspend instead — that
              keeps the data and can be undone.
            </div>
          </div>

          <label className="pf-field" style={{ marginTop: 16 }}>
            {/* One span, not three loose children: .pf-field is a column flex,
                so bare text around a <code> becomes three stacked rows with the
                chip stretched across the dialog. */}
            <span>
              Type <code className="pf-code">{company.slug}</code> to confirm
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className="pf-field" style={{ marginTop: 12 }}>
            Reason
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. contract ended, data removal requested"
            />
            <span className="pf-hint">
              Recorded in the platform audit log, which survives the deletion.
            </span>
          </label>
        </div>

        <div className="hx-dialog-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn pf-btn-danger" disabled={!matches || busy}>
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </form>
    </div>
  )
}
