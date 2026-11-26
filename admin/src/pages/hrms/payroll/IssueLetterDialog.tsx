/**
 * Issue a letter: pick the person, the letter type and a template on the left, edit the wording
 * with {{field}} pills that drop in at the cursor, and watch the letter fill in on the right.
 * The preview shows each field as a highlighted pill carrying its value (an example until an
 * employee is chosen); the other tab shows the fields themselves.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { ErrorNote } from '../../../components/ui'
import { IconCheck, IconClose, IconSheet } from '../../../components/Icons'
import type { User } from '../../../lib/types'
import { LETTER_TYPES, type LetterTemplate } from './Letters'
import '../../../styles/issueLetter.css'

interface Field { token: string; example: string }
interface Rendered { text: string; subject: string | null; unknown: string[]; empty: string[] }

const today = () => new Date().toISOString().slice(0, 10)
const TOKEN = /\{\{[^}]+\}\}/g
const SEP = ' ¦ '
/** The server lists fields without braces; the letter text wraps them as {{field}}. */
const bare = (token: string) => token.replace(/^\{\{\s*|\s*\}\}$/g, '').trim()
const braced = (token: string) => `{{${bare(token)}}}`
const longDate = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The letter as paragraphs; every {{field}} becomes a pill showing `show(token)`, and **bold** is honoured. */
function Letter({ body, show }: { body: string; show: (token: string) => string }) {
  return (
    <>
      {body.split(/\n\s*\n/).filter((b) => b.trim()).map((block, i) => (
        <p key={i} className="il-p">
          {block.split('\n').map((line, li) => (
            <Fragment key={li}>
              {li > 0 && <br />}
              {line.split(/(\{\{[^}]+\}\}|\*\*[^*]+\*\*)/).map((part, j) => {
                if (part.startsWith('{{')) return <span key={j} className="il-pill">{show(part)}</span>
                if (part.startsWith('**') && part.endsWith('**')) return <strong key={j}>{part.slice(2, -2)}</strong>
                return <Fragment key={j}>{part}</Fragment>
              })}
            </Fragment>
          ))}
        </p>
      ))}
    </>
  )
}

export default function IssueLetterDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const people = useQuery<User[]>('letters-people', () => api.get<User[]>('/admin/employees'))
  const tpls = useQuery<LetterTemplate[]>('letters-templates', () => api.get<LetterTemplate[]>('/letters/templates?active_only=true'))
  const fields = useQuery<Field[]>('letters-fields', () => api.get<Field[]>('/letters/fields'))
  const brand = useQuery<{ settings: { company_name?: string } } | null>('letters-brand', () => api.get<{ settings: { company_name?: string } }>('/payslip-design/letterhead').catch(() => null))

  const [userId, setUserId] = useState('')
  const [type, setType] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [dated, setDated] = useState(today())
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [mode, setMode] = useState<'sample' | 'vars'>('sample')
  const [values, setValues] = useState<Record<string, string>>({})
  const [unknown, setUnknown] = useState<string[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState<string | null>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const all = tpls.data ?? []
  const types = useMemo(() => LETTER_TYPES.filter(([v]) => all.some((t) => t.letter_type === v)), [all])
  const choices = all.filter((t) => !type || t.letter_type === type)
  const tpl = all.find((t) => t.id === templateId)
  const example = useMemo(() => Object.fromEntries((fields.data ?? []).map((f) => [bare(f.token), f.example])), [fields.data])

  useEffect(() => { if (!type && types.length) setType(types[0][0]) }, [types, type])
  useEffect(() => { if (type && !choices.some((t) => t.id === templateId)) setTemplateId(choices[0]?.id ?? '') }, [type, choices, templateId])
  useEffect(() => { if (tpl) { setSubject(tpl.subject ?? ''); setBody(tpl.body) } }, [tpl?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [onClose])

  // With an employee chosen the server fills the fields in: once for the whole letter (to catch unknown
  // fields), once for each distinct field so the pills can show their own values.
  useEffect(() => {
    if (!userId) { setValues({}); setUnknown([]); setNote(null); return }
    let live = true
    const t = setTimeout(async () => {
      try {
        const whole = await api.post<Rendered>('/letters/render', { user_id: userId, body, subject: subject || null, issued_on: dated })
        const tokens = [...new Set(body.match(TOKEN) ?? [])]
        let map: Record<string, string> = {}
        if (tokens.length) {
          const each = await api.post<Rendered>('/letters/render', { user_id: userId, body: tokens.join(SEP), subject: null, issued_on: dated })
          const parts = each.text.split(SEP.trim()).map((x) => x.trim())
          if (parts.length === tokens.length) map = Object.fromEntries(tokens.map((tk, i) => [tk, parts[i]]))
        }
        if (!live) return
        setValues(map); setUnknown(whole.unknown)
        setNote(whole.empty.length ? `No value yet for: ${whole.empty.join(', ')}` : null)
      } catch { /* keep the last preview */ }
    }, 350)
    return () => { live = false; clearTimeout(t) }
  }, [body, subject, userId, dated])

  const show = (token: string) => (mode === 'vars' ? token : (values[token] || example[bare(token)] || token))
  const person = (people.data ?? []).find((p) => p.id === userId)
  const company = brand.data?.settings?.company_name || 'Your company'

  function insert(token: string) {
    const el = bodyRef.current
    if (!el) { setBody((b) => b + token); return }
    const a = el.selectionStart ?? body.length
    const b = el.selectionEnd ?? body.length
    setBody(body.slice(0, a) + token + body.slice(b))
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + token.length, a + token.length) })
  }

  function reset() { if (tpl) { setSubject(tpl.subject ?? ''); setBody(tpl.body) } }

  async function create(issue: boolean) {
    if (!tpl || !userId) return
    setBusy(true); setFail(null)
    try {
      const filled = await api.post<Rendered>('/letters/render', { user_id: userId, body, subject: subject || null, issued_on: dated })
      if (filled.unknown.length) throw new Error(`Unknown field: ${filled.unknown.join(', ')}`)
      const draft = await api.post<{ id: string }>('/letters', { template_id: tpl.id, user_id: userId })
      await api.patch(`/letters/${draft.id}`, { body: filled.text, ...(filled.subject ? { subject: filled.subject } : {}) })
      if (issue) await api.post(`/letters/${draft.id}/issue`, { issued_on: dated })
      onDone()
    } catch (caught) { setFail((caught as Error).message); setBusy(false) }
  }

  const ready = Boolean(userId && tpl && body.trim() && unknown.length === 0)
  const title = (mode === 'vars' ? subject : (subject && subject.includes('{{') ? subject.replace(TOKEN, (m) => values[m] || example[bare(m)] || m) : subject)) || tpl?.name || 'Letter'

  return (
    <div className="il-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="il" role="dialog" aria-modal="true" aria-label="Issue a letter">
        <header className="il-head">
          <i className="il-badge" aria-hidden><IconSheet size={20} /></i>
          <div>
            <h2>Issue a Letter <span className="il-official">Official Template</span></h2>
            <p>Generate, customise and preview official HR correspondence</p>
          </div>
          <button type="button" className="il-close" aria-label="Close" onClick={onClose}><IconClose size={20} /></button>
        </header>

        <div className="il-main">
          <div className="il-left">
            <div className="il-sec">Recipient &amp; letter type</div>
            <div className="il-row3">
              <label className="il-f"><span>Employee</span>
                <select value={userId} onChange={(e) => setUserId(e.target.value)}>
                  <option value="">— Select —</option>
                  {(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.employee_code ? ` (${p.employee_code})` : ''}</option>)}
                </select></label>
              <label className="il-f"><span>Letter type</span>
                <select value={type} onChange={(e) => setType(e.target.value)}>
                  {types.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select></label>
              <label className="il-f"><span>Template</span>
                <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                  {choices.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select></label>
            </div>

            <div className="il-sec">Issue date &amp; reference</div>
            <div className="il-row2">
              <label className="il-f"><span>Dated</span>
                <input type="date" value={dated} onChange={(e) => setDated(e.target.value)} /></label>
              <label className="il-f"><span>Document reference ID</span>
                <div className="il-auto"><span>Assigned when issued</span><em>AUTO</em></div></label>
            </div>

            <div className="il-sec">Letter content <span className="il-warn">Edits apply to this letter only</span></div>
            <label className="il-f"><span>Subject</span>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
            <div className="il-f">
              <span className="il-bodyhead">Body <small>Click a field below to insert it at the cursor</small></span>
              <div className="il-editor">
                <div className="il-insert">
                  <b>Insert:</b>
                  {(fields.data ?? []).map((f) => <button key={f.token} type="button" className="il-chip" onClick={() => insert(braced(f.token))}>+ {braced(f.token)}</button>)}
                </div>
                <textarea ref={bodyRef} rows={9} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Letter body" />
              </div>
            </div>
            {fail && <ErrorNote>{fail}</ErrorNote>}
          </div>

          <aside className="il-right">
            <div className="il-rhead">
              <span className="il-live"><i /> Live preview</span>
              <span className="il-seg" role="tablist">
                <button type="button" className={mode === 'sample' ? 'is-on' : ''} onClick={() => setMode('sample')}>{userId ? 'Filled values' : 'Sample values'}</button>
                <button type="button" className={mode === 'vars' ? 'is-on' : ''} onClick={() => setMode('vars')}>Template variables</button>
              </span>
            </div>
            <div className="il-paper">
              <div className="il-ph">
                <div className="il-co"><i aria-hidden>{company.slice(0, 1).toUpperCase()}</i><div><b>{company}</b><span>Human Resources &amp; People Ops</span></div></div>
                <div className="il-date"><span>DATE</span><b>{longDate(dated)}</b></div>
              </div>
              <div className="il-title">{title}</div>
              <div className="il-body"><Letter body={body} show={show} /></div>
              <div className="il-sig">
                <b>{tpl?.signatory_name || 'Authorised Signatory'}</b>
                <span>{tpl?.signatory_title || `HR Department · ${company}`}</span>
                <em>A4 · OFFICIAL COPY</em>
              </div>
            </div>
            <p className="il-hint"><IconCheck size={13} /> Highlighted pills are fields filled in automatically when the letter is issued{person ? ` for ${person.full_name}` : ''}.</p>
          </aside>
        </div>

        <footer className="il-foot">
          <button type="button" className="il-link" onClick={reset}>Reset</button>
          <button type="button" className="il-link" disabled={busy || !ready} onClick={() => void create(false)}>Save as draft</button>
          <span className="il-status">{userId ? (unknown.length ? `Unknown field: ${unknown.join(', ')}` : (note ?? '')) : 'Pick an employee to issue.'}</span>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !ready} onClick={() => void create(true)}>{busy ? 'Issuing…' : 'Issue letter'}</button>
        </footer>
      </div>
    </div>
  )
}
