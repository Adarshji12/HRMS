/* Letters: every letter on record, and a dialog to issue a new one from a template. */

import { Fragment, useEffect, useMemo, useState } from 'react'
import { api, openPrintable } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type { User } from '../../../lib/types'
import { Dialog } from '../../crm/parts'
import '../../../styles/payroll.css'

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
      {dlg && <IssueDialog onClose={() => setDlg(false)} onDone={() => { setDlg(false); q.reload() }} />}
    </div>
  )
}

function IssueDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const people = useQuery<User[]>('letters-people', () => api.get<User[]>('/admin/employees'))
  const tpls = useQuery<LetterTemplate[]>('letters-templates', () => api.get<LetterTemplate[]>('/letters/templates?active_only=true'))
  const [userId, setUserId] = useState('')
  const [type, setType] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [dated, setDated] = useState(today())
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [shown, setShown] = useState('')
  const [shownSubject, setShownSubject] = useState('')
  const [unknown, setUnknown] = useState<string[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState<string | null>(null)
  const fields = useQuery<{ token: string; example: string }[]>('letters-fields', () => api.get<{ token: string; example: string }[]>('/letters/fields'))

  const all = tpls.data ?? []
  const types = useMemo(() => LETTER_TYPES.filter(([v]) => all.some((t) => t.letter_type === v)), [all])
  const choices = all.filter((t) => !type || t.letter_type === type)
  const tpl = all.find((t) => t.id === templateId)

  useEffect(() => { if (!type && types.length) setType(types[0][0]) }, [types, type])
  useEffect(() => { if (type && !choices.some((t) => t.id === templateId)) setTemplateId(choices[0]?.id ?? '') }, [type, choices, templateId])
  // The body shows the template as written, with its {{fields}}; picking another template swaps it in.
  useEffect(() => { if (tpl) { setSubject(tpl.subject ?? ''); setBody(tpl.body) } }, [tpl?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // The preview fills the fields in: for the chosen person, or with example values until there is one.
  useEffect(() => {
    if (!body.trim()) { setShown(''); return }
    const fill = (text: string) => (fields.data ?? []).reduce((acc, f) => acc.split(f.token).join(f.example), text)
    if (!userId) { setShown(fill(body)); setShownSubject(fill(subject)); setUnknown([]); setNote(null); return }
    let live = true
    const t = setTimeout(() => {
      api.post<{ text: string; subject: string | null; unknown: string[]; empty: string[] }>('/letters/render', { user_id: userId, body, subject: subject || null, issued_on: dated })
        .then((r) => { if (!live) return; setShown(r.text); setShownSubject(r.subject ?? ''); setUnknown(r.unknown); setNote(r.empty.length ? `No value yet for: ${r.empty.join(', ')}` : null) })
        .catch(() => undefined)
    }, 350)
    return () => { live = false; clearTimeout(t) }
  }, [body, subject, userId, dated, fields.data])

  async function issue() {
    if (!tpl || !userId) return
    setBusy(true); setFail(null)
    try {
      const filled = await api.post<{ text: string; subject: string | null; unknown: string[] }>('/letters/render', { user_id: userId, body, subject: subject || null, issued_on: dated })
      if (filled.unknown.length) throw new Error(`Unknown field: ${filled.unknown.join(', ')}`)
      const draft = await api.post<Letter>('/letters', { template_id: tpl.id, user_id: userId })
      await api.patch(`/letters/${draft.id}`, { body: filled.text, ...(filled.subject ? { subject: filled.subject } : {}) })
      await api.post(`/letters/${draft.id}/issue`, { issued_on: dated })
      onDone()
    } catch (caught) { setFail((caught as Error).message); setBusy(false) }
  }

  const sample = !userId
  return (
    <Dialog title="Issue a letter" wide onClose={onClose}
            footer={<>
              <span className="muted-sm" style={{ marginRight: 'auto' }}>{userId ? (unknown.length ? `Unknown field: ${unknown.join(', ')}` : (note ?? '')) : 'Pick an employee to issue.'}</span>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !userId || !tpl || !body.trim() || unknown.length > 0} onClick={() => void issue()}>{busy ? 'Issuing…' : 'Issue letter'}</button>
            </>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.3fr) minmax(260px,1fr)', gap: 20, padding: '8px 24px 20px' }}>
        <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
          <div className="pr-field-label">RECIPIENT AND TYPE</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <label className="pr-field"><span className="pr-field-label">Employee</span>
              <select value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">— Select —</option>
                {(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
              </select></label>
            <label className="pr-field"><span className="pr-field-label">Letter type</span>
              <select value={type} onChange={(e) => setType(e.target.value)}>
                {types.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select></label>
            <label className="pr-field"><span className="pr-field-label">Template</span>
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                {choices.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select></label>
          </div>
          <div className="pr-field-label">DATES</div>
          <label className="pr-field" style={{ maxWidth: 220 }}><span className="pr-field-label">Dated</span>
            <input type="date" value={dated} onChange={(e) => setDated(e.target.value)} /></label>
          {tpl?.description && <div className="muted-sm" style={{ background: 'var(--surface-2)', padding: '8px 12px', borderRadius: 10 }}>{tpl.description}</div>}
          <div className="pr-field-label">CONTENT</div>
          <label className="pr-field"><span className="pr-field-label">Subject</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
          <label className="pr-field"><span className="pr-field-label" style={{ display: 'flex', justifyContent: 'space-between' }}>Body <span className="muted-sm">Edits apply to this letter only</span></span>
            <textarea rows={12} value={body} onChange={(e) => setBody(e.target.value)} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }} /></label>
          {fail && <ErrorNote>{fail}</ErrorNote>}
        </div>
        <aside>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span className="pr-field-label">PREVIEW</span>
            {sample && <span style={{ background: '#ff3d71', color: '#fff', borderRadius: 999, padding: '4px 12px', fontSize: 12, fontWeight: 600 }}>Sample values</span>}
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 18, background: '#fff', fontSize: 13, maxHeight: 460, overflow: 'auto' }}>
            <div style={{ textAlign: 'center', fontWeight: 700, borderBottom: '1px solid var(--border)', paddingBottom: 10, marginBottom: 12 }}>{shownSubject || tpl?.name}</div>
            <LetterText text={shown} />
          </div>
        </aside>
      </div>
    </Dialog>
  )
}
