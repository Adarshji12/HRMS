/* Letters: every letter on record, and a dialog to issue a new one from a template. */

import { Fragment, useState } from 'react'
import { api, openPrintable } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import '../../../styles/payroll.css'
import IssueLetterDialog from './IssueLetterDialog'

export interface LetterTemplate {
  id: string; name: string; letter_type: string; description: string | null; subject: string | null; body: string
  signatory_name: string | null; signatory_title: string | null; employee_requestable: boolean; is_active: boolean
}
interface Letter {
  id: string; user_id: string; letter_type: string; template_name: string | null; reference_no: string | null
  subject: string | null; body: string; status: string; issued_on: string | null; user_name: string | null
}

export const LETTER_TYPES: [string, string][] = [
  ['offer', 'Offer Letter'], ['appointment', 'Appointment Letter'], ['confirmation', 'Confirmation Letter'],
  ['probation_extension', 'Probation Extension'], ['experience', 'Experience Letter'], ['relieving', 'Relieving Letter'],
  ['salary_certificate', 'Salary Certificate'], ['address_proof', 'Address Proof'], ['warning', 'Warning Letter'], ['custom', 'Custom'],
]
export const typeName = (t: string) => LETTER_TYPES.find(([v]) => v === t)?.[1] ?? t

/** Plain letter text as paragraphs, with **bold** honoured. */
export function LetterText({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n\s*\n/).filter((b) => b.trim()).map((block, i) => (
        <p key={i} style={{ margin: '0 0 12px', whiteSpace: 'pre-line' }}>
          {block.split(/(\*\*[^*]+\*\*)/).map((part, j) => part.startsWith('**') && part.endsWith('**')
            ? <strong key={j}>{part.slice(2, -2)}</strong> : <Fragment key={j}>{part}</Fragment>)}
        </p>
      ))}
    </>
  )
}

const today = () => new Date().toISOString().slice(0, 10)

export default function Letters() {
  const q = useQuery<Letter[]>('letters-all', () => api.get<Letter[]>('/letters'))
  const [search, setSearch] = useState('')
  const [type, setType] = useState('')
  const [dlg, setDlg] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const rows = (q.data ?? []).filter((l) => (!type || l.letter_type === type)
    && (!search.trim() || `${l.user_name} ${l.reference_no} ${l.subject}`.toLowerCase().includes(search.trim().toLowerCase())))

  async function act(l: Letter, what: 'issue' | 'revoke') {
    setError(null)
    try {
      if (what === 'issue') await api.post(`/letters/${l.id}/issue`, { issued_on: today() })
      else {
        const reason = window.prompt('Why is this letter being revoked?')
        if (!reason) return
        await api.post(`/letters/${l.id}/revoke`, { reason })
      }
      q.reload()
    } catch (caught) { setError((caught as Error).message) }
  }

  return (
    <div className="page">
      {error && <ErrorNote>{error}</ErrorNote>}
      <section className="card">
        <div className="card-head" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 className="card-title">Issued Letters</h2>
            <p className="muted-sm">{q.data?.length ?? 0} letters on record</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input placeholder="Name, code, reference…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 230 }} />
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All types</option>
              {LETTER_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <button className="btn btn-primary" onClick={() => setDlg(true)}>+ Issue Letter</button>
          </div>
        </div>
        {q.loading && !q.data ? <Loading /> : q.error ? <ErrorNote>{q.error}</ErrorNote> : rows.length === 0 ? (
          <Empty>
            <b>No letters issued yet</b>
            <p className="muted-sm">Offer, appointment, experience — eleven templates are ready to use.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>
                <th style={{ width: 28 }}><input type="checkbox" aria-label="Select all" checked={selected.size === rows.length}
                  onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>
                <th>Reference</th><th>Employee</th><th>Type</th><th>Issued</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id}>
                    <td><input type="checkbox" aria-label="Select" checked={selected.has(l.id)}
                               onChange={(e) => setSelected((p) => { const n = new Set(p); if (e.target.checked) n.add(l.id); else n.delete(l.id); return n })} /></td>
                    <td>{l.reference_no ?? <span className="muted">Draft</span>}</td>
                    <td><b>{l.user_name}</b></td>
                    <td>{typeName(l.letter_type)}</td>
                    <td>{l.issued_on ?? '—'}</td>
                    <td><span className={`pr-status ${l.status === 'issued' ? 'pr-status-ok' : l.status === 'revoked' ? 'pr-status-bad' : 'pr-status-muted'}`}>{l.status.replace(/^./, (c) => c.toUpperCase())}</span></td>
                    <td className="row-actions">
                      <button className="btn small" onClick={() => void openPrintable(`/letters/${l.id}/print`).catch((c) => setError((c as Error).message))}>View</button>{' '}
                      {l.status === 'draft' && <button className="btn small btn-primary" onClick={() => void act(l, 'issue')}>Issue</button>}
                      {l.status === 'issued' && <button className="btn small danger" onClick={() => void act(l, 'revoke')}>Revoke</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {dlg && <IssueLetterDialog onClose={() => setDlg(false)} onDone={() => { setDlg(false); q.reload() }} />}
    </div>
  )
}
