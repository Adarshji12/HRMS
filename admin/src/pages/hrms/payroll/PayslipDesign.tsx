/* Payslip design: pick a layout, set the company block and what prints, and watch the payslip redraw. */

import { useEffect, useRef, useState } from 'react'
import { api, postHtml } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { ErrorNote, Loading } from '../../../components/ui'
import { Dialog } from '../../crm/parts'
import LetterheadTab from './LetterheadTab'
import '../../../styles/payroll.css'
import '../../../styles/leavedesk.css'

interface Settings {
  template: string; company_name: string; cin: string; address: string; phone: string; email: string; accent: string
  pan: string; tan: string; pf_code: string; esic_code: string; lwf_code: string
  signatory_name: string; signatory_designation: string; footer_note: string
  show_bank: boolean; show_ids: boolean; show_attendance: boolean
  watermark_on: boolean; watermark_text: string; watermark_strength: number
  logo: boolean; signature: boolean; watermark_image: boolean
}
interface Payload { settings: Settings; templates: { key: string; name: string; blurb: string }[] }

type Draft = Omit<Settings, 'logo' | 'signature' | 'watermark_image'>
const TEXT_KEYS: (keyof Draft)[] = ['company_name', 'cin', 'address', 'phone', 'email', 'accent', 'pan', 'tan', 'pf_code', 'esic_code', 'lwf_code',
  'signatory_name', 'signatory_designation', 'footer_note', 'show_bank', 'show_ids', 'show_attendance', 'watermark_on', 'watermark_text', 'watermark_strength']

function pick(s: Settings): Draft {
  const out: Record<string, unknown> = { template: s.template }
  for (const k of TEXT_KEYS) out[k] = s[k]
  return out as unknown as Draft
}

function Thumb({ html }: { html: string | undefined }) {
  return (
    <div style={{ height: 210, overflow: 'hidden', background: '#eef2f6', borderRadius: 8, position: 'relative' }}>
      {html ? <iframe title="Template" srcDoc={html} tabIndex={-1}
                      style={{ width: 800, height: 1100, border: 0, transform: 'scale(.26)', transformOrigin: 'top left', pointerEvents: 'none' }} />
        : <Loading />}
    </div>
  )
}

function openForPrint(html: string) {
  // Printed from a hidden frame in this page: the print dialog appears straight away, with no blank tab first.
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:1100px;border:0;opacity:0;pointer-events:none'
  frame.onload = () => {
    const w = frame.contentWindow
    if (!w) return
    const go = () => { w.focus(); w.print() }
    const fonts = (w.document as Document & { fonts?: { ready: Promise<unknown> } }).fonts
    if (fonts) void fonts.ready.then(go, go); else go()
    w.onafterprint = () => frame.remove()
    setTimeout(() => frame.remove(), 120_000)
  }
  frame.srcdoc = html
  document.body.appendChild(frame)
}

function PayslipTab() {
  const q = useQuery<Payload>('payslip-design', () => api.get<Payload>('/payslip-design'))
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saved, setSaved] = useState<Draft | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [live, setLive] = useState('')
  const [view, setView] = useState<string | null>(null)
  const [viewHtml, setViewHtml] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const fileRef = useRef<Record<string, HTMLInputElement | null>>({})

  useEffect(() => { if (q.data && !draft) { const d = pick(q.data.settings); setDraft(d); setSaved(d) } }, [q.data, draft])

  // The template thumbnails use the saved settings, so they show the company's own block.
  useEffect(() => {
    if (!q.data || !saved) return
    for (const t of q.data.templates) {
      postHtml('/payslip-design/preview', { ...saved, template: t.key }).then((h) => setThumbs((p) => ({ ...p, [t.key]: h }))).catch(() => undefined)
    }
  }, [q.data, saved, q.data?.settings.logo, q.data?.settings.signature])

  // The live preview redraws a moment after typing stops.
  useEffect(() => {
    if (!draft) return
    const t = setTimeout(() => { postHtml('/payslip-design/preview', draft).then(setLive).catch(() => undefined) }, 400)
    return () => clearTimeout(t)
  }, [draft, q.data?.settings.logo, q.data?.settings.signature, q.data?.settings.watermark_image])

  if (q.error) return <div className="page"><ErrorNote>{q.error}</ErrorNote></div>
  if (!q.data || !draft || !saved) return <div className="page"><Loading /></div>
  const data = q.data
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v })

  async function save(next: Draft = draft!) {
    setBusy(true); setError(null); setMessage(null)
    try {
      await api.put('/payslip-design', next)
      setSaved(next); setDraft(next); setMessage('Saved.')
    } catch (caught) { setError((caught as Error).message) } finally { setBusy(false) }
  }

  async function upload(kind: string, file: File | undefined) {
    if (!file) return
    setError(null)
    const form = new FormData(); form.append('file', file)
    try { await api.upload(`/payslip-design/image/${kind}`, form); q.reload() } catch (caught) { setError((caught as Error).message) }
  }
  async function removeImage(kind: string) {
    try { await api.del(`/payslip-design/image/${kind}`); q.reload() } catch (caught) { setError((caught as Error).message) }
  }

  async function open(key: string) {
    setView(key); setViewHtml('')
    try { setViewHtml(await postHtml('/payslip-design/preview', { ...draft, template: key })) } catch (caught) { setError((caught as Error).message) }
  }

  const text = (label: string, k: keyof Draft, opts: { wide?: boolean; placeholder?: string } = {}) => (
    <label className="pr-field" style={opts.wide ? { gridColumn: '1 / -1' } : undefined}>
      <span className="pr-field-label">{label}</span>
      <input value={String(draft[k] ?? '')} placeholder={opts.placeholder} onChange={(e) => set(k, e.target.value as never)} />
    </label>
  )
  const check = (label: string, hint: string, k: 'show_bank' | 'show_ids' | 'show_attendance') => (
    <label className="pr-check"><input type="checkbox" checked={draft[k]} onChange={(e) => set(k, e.target.checked)} />
      <span>{label}<span className="pr-field-hint">{hint}</span></span></label>
  )
  const image = (label: string, kind: 'logo' | 'signature' | 'watermark', has: boolean, hint: string) => (
    <div style={{ display: 'grid', gap: 6 }}>
      <span className="pr-field-label">{label}</span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="muted-sm">{has ? 'Uploaded' : 'None'}</span>
        <input ref={(el) => { fileRef.current[kind] = el }} type="file" accept="image/png,image/jpeg,image/webp" hidden
               onChange={(e) => { void upload(kind, e.target.files?.[0]); e.target.value = '' }} />
        <button className="btn small" onClick={() => fileRef.current[kind]?.click()}>Upload</button>
        {has && <button className="btn small danger" onClick={() => void removeImage(kind)}>Remove</button>}
      </div>
      <span className="muted-sm">{hint}</span>
    </div>
  )

  return (
    <div className="page">
      {error && <ErrorNote>{error}</ErrorNote>}
      <section className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <h2 className="card-title">Payslip templates</h2>
          <span className="muted-sm">Prints on every payslip and payslip email</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 14, marginTop: 12 }}>
          {data.templates.map((t) => {
            const on = saved.template === t.key
            return (
              <article key={t.key} style={{ border: `2px solid ${on ? 'var(--status-good, #0f9d8a)' : 'var(--border)'}`, borderRadius: 12, padding: 10, display: 'grid', gap: 8, cursor: 'pointer' }}
                       onClick={() => void open(t.key)}>
                <Thumb html={thumbs[t.key]} />
                <div><b>{t.name}</b><div className="muted-sm">{t.blurb}</div></div>
                <button className={`btn small ${on ? '' : 'btn-primary'}`} disabled={on || busy}
                        onClick={(e) => { e.stopPropagation(); void save({ ...draft, template: t.key }) }}>{on ? 'In use' : 'Use'}</button>
              </article>
            )
          })}
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) minmax(280px,1fr)', gap: 16, marginTop: 16, alignItems: 'start' }}>
        <section className="card" style={{ padding: 18, display: 'grid', gap: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 className="card-title">Payslip settings</h2>
            <button className="btn btn-primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
          {message && <div className="notice notice-ok">{message}</div>}

          <div className="pr-field-label">COMPANY</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {text('Company name', 'company_name')}{text('CIN', 'cin')}
            {text('Address', 'address', { wide: true })}
            {text('Phone', 'phone')}{text('Email', 'email')}
            <label className="pr-field"><span className="pr-field-label">Accent colour</span>
              <input type="color" value={draft.accent} onChange={(e) => set('accent', e.target.value)} style={{ width: '100%', height: 40 }} /></label>
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, display: 'grid', gap: 12 }}>
            <div><b>Statutory identifiers</b><div className="muted-sm">Printed on Form 16, returns and the payslip for suppliers.</div></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {text('Company PAN', 'pan')}{text('Company TAN', 'tan')}
              {text('PF establishment code', 'pf_code')}{text('ESIC employer code', 'esic_code')}
              {text('LWF establishment code', 'lwf_code')}
            </div>
          </div>

          <div className="pr-field-label">IMAGES</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            {image('Logo', 'logo', data.settings.logo, 'PNG or JPEG')}
            {image('Signature', 'signature', data.settings.signature, 'A transparent PNG works best')}
            {image('Watermark', 'watermark', data.settings.watermark_image, 'Used instead of the text below')}
          </div>

          <div className="pr-field-label">SIGNATURE AND FOOTER</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {text('Signatory name', 'signatory_name', { placeholder: 'Authorised Signatory' })}{text('Signatory designation', 'signatory_designation')}
            {text('Footer note', 'footer_note', { wide: true, placeholder: 'Queries to hr@yourcompany.com' })}
          </div>

          <div className="pr-field-label">WHAT PRINTS ON A PAYSLIP</div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, display: 'grid', gap: 10 }}>
            {check('Bank account the salary was paid into', 'Bank name and the last digits of the account.', 'show_bank')}
            {check('PAN, UAN and ESIC numbers', 'The employee’s own identifiers.', 'show_ids')}
            {check('Attendance summary', 'Days worked, paid and lost to pay.', 'show_attendance')}
          </div>

          <div className="pr-field-label">WATERMARK</div>
          <label className="pr-check"><input type="checkbox" checked={draft.watermark_on} onChange={(e) => set('watermark_on', e.target.checked)} />
            <span>Print a watermark behind the text<span className="pr-field-hint">The uploaded image is used when there is one, otherwise the words below.</span></span></label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {text('Watermark text', 'watermark_text', { placeholder: 'CONFIDENTIAL' })}
            <label className="pr-field"><span className="pr-field-label">Strength {draft.watermark_strength}%</span>
              <input type="range" min={1} max={30} value={draft.watermark_strength} onChange={(e) => set('watermark_strength', Number(e.target.value))} /></label>
          </div>
        </section>

        <aside className="card" style={{ padding: 14, position: 'sticky', top: 16 }}>
          <div className="pr-field-label" style={{ marginBottom: 8 }}>LIVE PREVIEW</div>
          <div style={{ height: 520, overflow: 'hidden', background: '#eef2f6', borderRadius: 8 }}>
            <iframe title="Live preview" srcDoc={live} style={{ width: 800, height: 1100, border: 0, transform: 'scale(.42)', transformOrigin: 'top left' }} />
          </div>
          <p className="muted-sm" style={{ marginBottom: 0 }}>Sample figures only. Open a template above for the full page, or use Test PDF there.</p>
        </aside>
      </div>

      {view && (
        <Dialog title={data.templates.find((t) => t.key === view)?.name ?? 'Template'} subtitle={data.templates.find((t) => t.key === view)?.blurb} wide className="dlg-preview" onClose={() => setView(null)}
                footer={<>
                  <button className="btn" disabled={!viewHtml} onClick={() => openForPrint(viewHtml)}>Test PDF</button>
                  {saved.template === view ? <button className="btn" disabled>In use</button>
                    : <button className="btn btn-primary" disabled={busy} onClick={() => void save({ ...draft, template: view }).then(() => setView(null))}>Use this template</button>}
                </>}>
          <div style={{ padding: '0 16px 16px' }}>
            {viewHtml ? <iframe title="Template preview" srcDoc={viewHtml} style={{ width: '100%', height: 'min(640px, calc(100vh - 300px))', minHeight: 320, border: 0, background: '#eef2f6' }} /> : <Loading />}
          </div>
        </Dialog>
      )}
    </div>
  )
}

export default function PayslipDesign() {
  const [tab, setTab] = useState<'payslip' | 'letterhead'>('payslip')
  return (
    <>
      <div className="page" style={{ paddingBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div className="ld-tabs ld-tabs-sm" role="tablist" style={{ marginBottom: 0 }}>
            <button className={`ld-tab ${tab === 'payslip' ? 'is-on' : ''}`} onClick={() => setTab('payslip')}>Payslip</button>
            <button className={`ld-tab ${tab === 'letterhead' ? 'is-on' : ''}`} onClick={() => setTab('letterhead')}>Letterhead</button>
          </div>
          <span className="muted-sm">{tab === 'payslip' ? 'Eight payslip layouts and the settings that print on them.' : 'Eight letterhead layouts, with their own logo, signature and company block.'}</span>
        </div>
      </div>
      {tab === 'payslip' ? <PayslipTab /> : <LetterheadTab />}
    </>
  )
}
