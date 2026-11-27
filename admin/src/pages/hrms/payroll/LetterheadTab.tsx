/* Letterhead: the header every issued letter prints on. Eight layouts, a company block, images, border and watermark. */

import { useEffect, useRef, useState } from 'react'
import { api, postHtml } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { ErrorNote, Loading } from '../../../components/ui'
import { Dialog } from '../../crm/parts'
import TemplateThumb from './TemplateThumb'
import '../../../styles/payroll.css'

interface Settings {
  template: string; company_name: string; gstin: string; address: string; phone: string; email: string; accent: string
  show_logo: boolean; logo_pos: string; show_details: boolean; details_pos: string
  signatory_name: string; signatory_designation: string; show_signature: boolean; signature_pos: string
  show_footer: boolean; footer_note: string; border_on: boolean; border_colour: string; border_thickness: string; border_margin: string
  watermark_on: boolean; watermark_text: string; watermark_strength: number
  logo: boolean; signature: boolean; watermark_image: boolean
}
type Draft = Omit<Settings, 'logo' | 'signature' | 'watermark_image'>
interface Payload { settings: Settings; templates: { key: string; name: string; blurb: string }[] }

function pick(s: Settings): Draft {
  const { logo: _l, signature: _s, watermark_image: _w, ...rest } = s
  void _l; void _s; void _w
  return rest
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

function Segmented({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <span style={{ display: 'inline-flex', gap: 2, padding: 3, border: '1px solid var(--border)', borderRadius: 10 }}>
      {options.map(([v, l]) => (
        <button key={v} type="button" className="btn small" onClick={() => onChange(v)}
                style={value === v ? { background: 'var(--status-good, #0f9d8a)', color: '#fff', border: 0 } : { border: 0, background: 'transparent' }}>{l}</button>
      ))}
    </span>
  )
}

export default function LetterheadTab() {
  const q = useQuery<Payload>('letterhead-design', () => api.get<Payload>('/payslip-design/letterhead'))
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saved, setSaved] = useState<Draft | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [live, setLive] = useState('')
  const [view, setView] = useState<string | null>(null)
  const [viewHtml, setViewHtml] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<Record<string, HTMLInputElement | null>>({})

  useEffect(() => { if (q.data && !draft) { const d = pick(q.data.settings); setDraft(d); setSaved(d) } }, [q.data, draft])
  const imgKey = `${q.data?.settings.logo}${q.data?.settings.signature}${q.data?.settings.watermark_image}`

  useEffect(() => {
    if (!q.data || !saved) return
    for (const t of q.data.templates) {
      postHtml('/payslip-design/letterhead/preview', { ...saved, template: t.key }).then((h) => setThumbs((p) => ({ ...p, [t.key]: h }))).catch(() => undefined)
    }
  }, [q.data, saved, imgKey])

  useEffect(() => {
    if (!draft) return
    const t = setTimeout(() => { postHtml('/payslip-design/letterhead/preview', draft).then(setLive).catch(() => undefined) }, 400)
    return () => clearTimeout(t)
  }, [draft, imgKey])

  if (q.error) return <div className="page"><ErrorNote>{q.error}</ErrorNote></div>
  if (!q.data || !draft || !saved) return <div className="page"><Loading /></div>
  const data = q.data
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v })

  async function save(next: Draft = draft!) {
    setBusy(true); setError(null)
    try { await api.put('/payslip-design/letterhead', next); setSaved(next); setDraft(next) }
    catch (caught) { setError((caught as Error).message) } finally { setBusy(false) }
  }
  async function upload(kind: string, file: File | undefined) {
    if (!file) return
    const form = new FormData(); form.append('file', file)
    try { await api.upload(`/payslip-design/letterhead/image/${kind}`, form); q.reload() } catch (caught) { setError((caught as Error).message) }
  }
  async function removeImage(kind: string) {
    try { await api.del(`/payslip-design/letterhead/image/${kind}`); q.reload() } catch (caught) { setError((caught as Error).message) }
  }
  async function open(key: string) {
    setView(key); setViewHtml('')
    try { setViewHtml(await postHtml('/payslip-design/letterhead/preview', { ...draft, template: key })) } catch (caught) { setError((caught as Error).message) }
  }

  const text = (label: string, k: keyof Draft, o: { wide?: boolean; placeholder?: string } = {}) => (
    <label className="pr-field" style={o.wide ? { gridColumn: '1 / -1' } : undefined}>
      <span className="pr-field-label">{label}</span>
      <input value={String(draft[k] ?? '')} placeholder={o.placeholder} onChange={(e) => set(k, e.target.value as never)} />
    </label>
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
  const toggleRow = (label: string, hint: string | null, on: boolean, onChange: (v: boolean) => void, control?: React.ReactNode) => (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
      <label className="pr-check"><input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}{hint && <span className="pr-field-hint">{hint}</span>}</span></label>
      {control}
    </div>
  )
  const section = (t: string) => <div className="pr-field-label" style={{ marginTop: 4 }}>{t}</div>

  return (
    <div className="page" style={{ paddingBottom: dirty ? 90 : undefined }}>
      {error && <ErrorNote>{error}</ErrorNote>}
      <section className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <h2 className="card-title">Letterhead templates</h2>
          <span className="muted-sm">Prints on every letter — offer, confirmation, experience, relieving</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 14, marginTop: 12 }}>
          {data.templates.map((t) => {
            const on = saved.template === t.key
            return (
              <article key={t.key} style={{ border: `2px solid ${on ? 'var(--status-good, #0f9d8a)' : 'var(--border)'}`, borderRadius: 12, padding: 10, display: 'grid', gap: 8, cursor: 'pointer' }}
                       onClick={() => void open(t.key)}>
                <TemplateThumb html={thumbs[t.key]} title={t.name} />
                <div><b>{t.name}</b><div className="muted-sm">{t.blurb}</div></div>
                <button className={`btn small ${on ? '' : 'btn-primary'}`} disabled={on || busy}
                        onClick={(e) => { e.stopPropagation(); void save({ ...draft, template: t.key }) }}>{on ? 'In use' : 'Use'}</button>
              </article>
            )
          })}
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) minmax(280px,1fr)', gap: 16, marginTop: 16, alignItems: 'start' }}>
        <section className="card" style={{ padding: 18, display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 className="card-title">Letterhead settings</h2>
            <span className="muted-sm">Used by letters only — payslips have their own</span>
          </div>
          {section('COMPANY')}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {text('Company name', 'company_name')}{text('GSTIN', 'gstin')}
            {text('Address', 'address', { wide: true })}
            {text('Phone', 'phone')}{text('Email', 'email')}
            <label className="pr-field"><span className="pr-field-label">Accent colour</span>
              <input type="color" value={draft.accent} onChange={(e) => set('accent', e.target.value)} style={{ width: '100%', height: 40 }} /></label>
          </div>
          {section('IMAGES')}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            {image('Logo', 'logo', data.settings.logo, 'PNG or JPEG.')}
            {image('Signature', 'signature', data.settings.signature, 'A transparent PNG prints best.')}
            {image('Watermark', 'watermark', data.settings.watermark_image, 'Used instead of the text below.')}
          </div>
          {section('HEADER')}
          {toggleRow('Show the logo', 'Banded and Stripe place it themselves and ignore the position.', draft.show_logo, (v) => set('show_logo', v),
            <Segmented value={draft.logo_pos} options={[['left', 'Left'], ['centre', 'Centre'], ['right', 'Right']]} onChange={(v) => set('logo_pos', v)} />)}
          {toggleRow('Show address, phone and GSTIN', null, draft.show_details, (v) => set('show_details', v),
            <Segmented value={draft.details_pos} options={[['left', 'Left'], ['centre', 'Centre'], ['right', 'Right']]} onChange={(v) => set('details_pos', v)} />)}
          {section('SIGNATURE AND FOOTER')}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {text('Signatory name', 'signatory_name', { placeholder: 'Authorised Signatory' })}{text('Signatory designation', 'signatory_designation')}
          </div>
          {toggleRow('Print the signature image', 'The ruled line and the name print either way.', draft.show_signature, (v) => set('show_signature', v),
            <Segmented value={draft.signature_pos} options={[['left', 'Left'], ['right', 'Right']]} onChange={(v) => set('signature_pos', v)} />)}
          {toggleRow('Print the footer band', null, draft.show_footer, (v) => set('show_footer', v))}
          {text('Footer note', 'footer_note', { wide: true, placeholder: 'Registered office · CIN U00000XX0000XXX000000' })}
          {section('PAGE BORDER')}
          {toggleRow('Draw a border around the page', null, draft.border_on, (v) => set('border_on', v))}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            <label className="pr-field"><span className="pr-field-label">Colour</span>
              <input type="color" value={draft.border_colour} onChange={(e) => set('border_colour', e.target.value)} style={{ width: '100%', height: 40 }} /></label>
            <label className="pr-field"><span className="pr-field-label">Thickness</span>
              <select value={draft.border_thickness} onChange={(e) => set('border_thickness', e.target.value)}>
                <option value="hairline">Hairline</option><option value="thin">Thin</option><option value="medium">Medium</option><option value="thick">Thick</option></select></label>
            <label className="pr-field"><span className="pr-field-label">Margin</span>
              <select value={draft.border_margin} onChange={(e) => set('border_margin', e.target.value)}>
                <option value="tight">Tight</option><option value="normal">Normal</option><option value="wide">Wide</option></select></label>
          </div>
          {section('WATERMARK')}
          {toggleRow('Print a watermark behind the text', 'The uploaded image is used when there is one, otherwise the words below.', draft.watermark_on, (v) => set('watermark_on', v))}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {text('Watermark text', 'watermark_text', { placeholder: 'CONFIDENTIAL' })}
            <label className="pr-field"><span className="pr-field-label">Strength {draft.watermark_strength}%</span>
              <input type="range" min={1} max={30} value={draft.watermark_strength} onChange={(e) => set('watermark_strength', Number(e.target.value))} /></label>
          </div>
        </section>

        <aside className="card" style={{ padding: 14, position: 'sticky', top: 16 }}>
          <div className="pr-field-label" style={{ marginBottom: 8 }}>LIVE PREVIEW</div>
          <div style={{ height: 560, overflow: 'hidden', background: '#eef2f6', borderRadius: 8 }}>
            <iframe title="Live preview" srcDoc={live} style={{ width: 800, height: 1100, border: 0, transform: 'scale(.4)', transformOrigin: 'top left' }} />
          </div>
          <p className="muted-sm" style={{ marginBottom: 0 }}>An A4 letter at scale. Open a template above to print a real specimen.</p>
        </aside>
      </div>

      {dirty && (
        <div style={{ position: 'sticky', bottom: 12, marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '12px 18px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 12, boxShadow: '0 4px 14px rgba(0,0,0,.08)' }}>
          <span><b>Unsaved changes</b> <span className="muted-sm" style={{ color: '#92400e' }}>Nothing is stored until you save.</span></span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button className="btn" disabled={busy} onClick={() => setDraft(saved)}>Discard</button>
            <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</button>
          </span>
        </div>
      )}

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
