/* Letter templates: the wording every letter starts from, with merge fields filled in per employee. */

import { useRef, useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import { Dialog } from '../../crm/parts'
import { LETTER_TYPES, LetterText, typeName, type LetterTemplate } from './Letters'
import '../../../styles/payroll.css'

interface Field { token: string; label: string; example: string; group: string }

export default function LetterTemplates() {
  const q = useQuery<LetterTemplate[]>('letters-templates-all', () => api.get<LetterTemplate[]>('/letters/templates'))
  const [dlg, setDlg] = useState<LetterTemplate | 'new' | null>(null)
  const [view, setView] = useState<LetterTemplate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function seed() {
    setBusy(true); setError(null)
    try { await api.post('/letters/templates/seed', {}); q.reload() } catch (caught) { setError((caught as Error).message) } finally { setBusy(false) }
  }
  async function toggle(t: LetterTemplate) {
    try { await api.patch(`/letters/templates/${t.id}`, { is_active: !t.is_active }); q.reload() } catch (caught) { setError((caught as Error).message) }
  }
  async function remove(t: LetterTemplate) {
    if (!window.confirm(`Delete “${t.name}”? Letters already issued from it are not affected.`)) return
    try { await api.del(`/letters/templates/${t.id}`); q.reload() } catch (caught) { setError((caught as Error).message) }
  }

  return (
    <div className="page">
      {error && <ErrorNote>{error}</ErrorNote>}
      <section className="card">
        <div className="card-head" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 className="card-title">Letter Templates</h2>
            <p className="muted-sm">The wording letters start from. Fields in double braces are filled in for each employee.</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {(q.data?.length ?? 0) > 0 && <button className="btn" disabled={busy} onClick={() => void seed()}>Add starter templates</button>}
            <button className="btn btn-primary" onClick={() => setDlg('new')}>+ New Template</button>
          </div>
        </div>
        {q.loading && !q.data ? <Loading /> : q.error ? <ErrorNote>{q.error}</ErrorNote> : !q.data?.length ? (
          <Empty>
            <b>No templates yet</b>
            <p className="muted-sm">Start from the eleven starter templates, or write your own.</p>
            <button className="btn btn-primary" disabled={busy} onClick={() => void seed()}>{busy ? 'Adding…' : 'Add starter templates'}</button>
          </Empty>
        ) : (
          <div className="lt-grid">
            {q.data.map((t) => (
              <article key={t.id} className={`lt-card${t.is_active ? '' : ' is-off'}`}>
                <div className="lt-top">
                  <span className="lt-type">{typeName(t.letter_type)}</span>
                  <span className={`pr-status ${t.is_active ? 'pr-status-ok' : 'pr-status-muted'}`}>{t.is_active ? 'Active' : 'Inactive'}</span>
                </div>
                <h3 className="lt-name" title={t.name}>{t.name}</h3>
                <p className="lt-desc muted-sm">{t.description || (t.subject ? `Subject: ${t.subject}` : 'No description')}</p>
                <div className="lt-meta">{t.employee_requestable ? 'Employees can request' : 'HR issues only'}</div>
                <div className="lt-actions">
                  <button className="btn small" onClick={() => setDlg(t)}>Edit</button>
                  <button className="btn small" onClick={() => setView(t)}>Preview</button>
                  <button className="btn small" onClick={() => void toggle(t)}>{t.is_active ? 'Deactivate' : 'Activate'}</button>
                  <button className="btn small danger" onClick={() => void remove(t)}>Delete</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {view && (
        <Dialog title={view.name} subtitle={view.subject ?? undefined} wide onClose={() => setView(null)}
                footer={<button className="btn" onClick={() => setView(null)}>Close</button>}>
          <div className="lt-preview"><LetterText text={view.body} /></div>
        </Dialog>
      )}
      {dlg && <TemplateDialog existing={dlg === 'new' ? null : dlg} onClose={() => setDlg(null)} onSaved={() => { setDlg(null); q.reload() }} />}
    </div>
  )
}

function TemplateDialog({ existing, onClose, onSaved }: { existing: LetterTemplate | null; onClose: () => void; onSaved: () => void }) {
  const fields = useQuery<Field[]>('letters-fields', () => api.get<Field[]>('/letters/fields'))
  const [d, setD] = useState(() => ({
    name: existing?.name ?? '', letter_type: existing?.letter_type ?? 'offer', description: existing?.description ?? '',
    subject: existing?.subject ?? '', body: existing?.body ?? '', signatory_name: existing?.signatory_name ?? '',
    signatory_title: existing?.signatory_title ?? '', employee_requestable: existing?.employee_requestable ?? false, is_active: existing?.is_active ?? true,
  }))
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)

  function insert(token: string) {
    const el = area.current
    const at = el ? el.selectionStart : d.body.length
    const end = el ? el.selectionEnd : d.body.length
    setD({ ...d, body: d.body.slice(0, at) + token + d.body.slice(end) })
  }

  async function save() {
    setBusy(true); setFail(null)
    try {
      if (existing) await api.patch(`/letters/templates/${existing.id}`, d)
      else await api.post('/letters/templates', d)
      onSaved()
    } catch (caught) { setFail((caught as Error).message); setBusy(false) }
  }
  const groups = [...new Set((fields.data ?? []).map((f) => f.group))]

  return (
    <Dialog title={existing ? 'Edit template' : 'New template'} wide onClose={onClose}
            footer={<>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !d.name.trim() || !d.body.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
            </>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) minmax(220px,1fr)', gap: 20, padding: '8px 24px 20px', flex: 1, minHeight: 0, overflowY: 'auto', alignContent: 'start' }}>
        <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 12 }}>
            <label className="pr-field"><span className="pr-field-label">Name</span>
              <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></label>
            <label className="pr-field"><span className="pr-field-label">Letter type</span>
              <select value={d.letter_type} onChange={(e) => setD({ ...d, letter_type: e.target.value })}>
                {LETTER_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          </div>
          <label className="pr-field"><span className="pr-field-label">Description</span>
            <input value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></label>
          <label className="pr-field"><span className="pr-field-label">Subject</span>
            <input value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} /></label>
          <label className="pr-field"><span className="pr-field-label">Body</span>
            <textarea ref={area} rows={12} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }} /></label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label className="pr-field"><span className="pr-field-label">Signatory name</span>
              <input value={d.signatory_name} onChange={(e) => setD({ ...d, signatory_name: e.target.value })} /></label>
            <label className="pr-field"><span className="pr-field-label">Signatory title</span>
              <input value={d.signatory_title} onChange={(e) => setD({ ...d, signatory_title: e.target.value })} /></label>
          </div>
          <label className="pr-check"><input type="checkbox" checked={d.employee_requestable} onChange={(e) => setD({ ...d, employee_requestable: e.target.checked })} /><span>Employees can request this letter</span></label>
          <label className="pr-check"><input type="checkbox" checked={d.is_active} onChange={(e) => setD({ ...d, is_active: e.target.checked })} /><span>Active</span></label>
          {fail && <ErrorNote>{fail}</ErrorNote>}
        </div>
        <aside style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--surface-2)', alignSelf: 'start', maxHeight: 520, overflow: 'auto' }}>
          <div className="pr-field-label" style={{ marginBottom: 8 }}>MERGE FIELDS</div>
          <p className="muted-sm" style={{ marginTop: 0 }}>Click to insert at the cursor.</p>
          {groups.map((g) => (
            <div key={g} style={{ marginBottom: 10 }}>
              <div className="muted-sm" style={{ fontWeight: 600, marginBottom: 4 }}>{g}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {(fields.data ?? []).filter((f) => f.group === g).map((f) => (
                  <button key={f.token} type="button" className="btn small" title={`e.g. ${f.example}`} onClick={() => insert(f.token)}>{f.label}</button>
                ))}
              </div>
            </div>
          ))}
        </aside>
      </div>
    </Dialog>
  )
}
