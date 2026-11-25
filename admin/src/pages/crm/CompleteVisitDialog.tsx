/**
 * Completing a visit: where it was (GPS), what was done, the customer's
 * signature and an optional next follow-up. The server keeps one outcome text,
 * so the written parts are joined into it; the follow-up is booked with the close.
 */

import { useEffect, useRef, useState } from 'react'
import { ErrorNote } from '../../components/ui'
import { IconAlert, IconCheck, IconPin } from '../../components/Icons'
import { crm, crmError, localToISO, type Visit } from './api'
import { Dialog } from './parts'

type Where = { state: 'reading' } | { state: 'ok'; lat: number; lng: number; acc: number } | { state: 'denied'; why: string }

function Signature({ onChange }: { onChange: (drawn: boolean) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const at = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect()
    return [(e.clientX - r.left) * (canvas.current!.width / r.width), (e.clientY - r.top) * (canvas.current!.height / r.height)] as const
  }
  function down(e: React.PointerEvent) {
    const c = canvas.current?.getContext('2d')
    if (!c) return
    drawing.current = true
    canvas.current!.setPointerCapture(e.pointerId)
    const [x, y] = at(e)
    c.beginPath()
    c.moveTo(x, y)
  }
  function move(e: React.PointerEvent) {
    if (!drawing.current) return
    const c = canvas.current!.getContext('2d')!
    const [x, y] = at(e)
    c.lineWidth = 2
    c.lineCap = 'round'
    c.strokeStyle = '#111'
    c.lineTo(x, y)
    c.stroke()
    onChange(true)
  }
  const clear = () => {
    const c = canvas.current
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
    onChange(false)
  }
  return (
    <>
      <canvas ref={canvas} width={600} height={220} className="cv-pad" onPointerDown={down} onPointerMove={move} onPointerUp={() => { drawing.current = false }} />
      <div className="cv-pad-foot"><span>Ask the customer to sign here</span><button type="button" className="link-btn" onClick={clear}>Clear</button></div>
    </>
  )
}

export default function CompleteVisitDialog({ visit, onClose, onDone }: { visit: Visit; onClose: () => void; onDone: () => void }) {
  const [where, setWhere] = useState<Where>({ state: 'reading' })
  const [work, setWork] = useState('')
  const [issue, setIssue] = useState('')
  const [fix, setFix] = useState('')
  const [parts, setParts] = useState(false)
  const [partsText, setPartsText] = useState('')
  const [paid, setPaid] = useState(false)
  const [amount, setAmount] = useState('')
  const [signed, setSigned] = useState(false)
  const [nextDate, setNextDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function read() {
    setWhere({ state: 'reading' })
    if (!navigator.geolocation) { setWhere({ state: 'denied', why: 'This browser cannot read a location.' }); return }
    navigator.geolocation.getCurrentPosition(
      (p) => setWhere({ state: 'ok', lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }),
      (e) => setWhere({ state: 'denied', why: e.code === 1 ? 'Location access was denied. Allow it for this site and try again.' : 'The location could not be read.' }),
      { enableHighAccuracy: true, timeout: 15000 },
    )
  }
  useEffect(read, [])

  const needs = [where.state === 'reading' && 'reading GPS', !work.trim() && 'activity details'].filter(Boolean) as string[]

  async function submit() {
    setBusy(true)
    setError(null)
    const lines = [
      work.trim(),
      issue.trim() && `Issue / complaint: ${issue.trim()}`,
      fix.trim() && `Resolution: ${fix.trim()}`,
      parts && partsText.trim() && `Parts / items used: ${partsText.trim()}`,
      paid && amount && `Payment received: ₹${amount}`,
      signed && 'Customer signature taken on site',
      where.state === 'ok' && `Location: ${where.lat.toFixed(5)}, ${where.lng.toFixed(5)} (±${where.acc}m)`,
    ].filter(Boolean)
    try {
      await crm.closeVisit(visit.id, { outcome: lines.join('\n'), next_follow_up_at: nextDate ? localToISO(`${nextDate}T10:00`) : null })
      onDone()
    } catch (e) {
      setError(crmError(e, 'That visit could not be closed'))
      setBusy(false)
    }
  }

  const when = new Date(visit.scheduled_at).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  return (
    <Dialog wide title={`Complete Visit · ${visit.visit_no}`}
      subtitle={`${visit.customer_name ?? ''} · ${visit.visit_type_name ?? 'Visit'} · ${when}${visit.employee_name ? ` · ${visit.employee_name}` : ''}`}
      onClose={onClose}
      footer={<>
        {needs.length > 0 && <span className="cv-need"><IconAlert size={14} /> Still needed: {needs.join(', ')}</span>}
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || needs.length > 0} onClick={submit}><IconCheck size={14} /> {busy ? 'Saving…' : 'Complete Visit'}</button>
      </>}>
      <div className="cv">
        <div className="cv-left">
          <section className="cv-box">
            <header><b><IconPin size={14} /> Location</b>{where.state !== 'reading' && <button type="button" className="link-btn" onClick={read}>Read again</button>}</header>
            {where.state === 'reading' && <p className="muted-sm">Reading GPS…</p>}
            {where.state === 'ok' && <p className="muted-sm">{where.lat.toFixed(5)}, {where.lng.toFixed(5)} · ±{where.acc}m</p>}
            {where.state === 'denied' && <p className="cv-warn"><IconAlert size={14} /> {where.why}</p>}
          </section>
          <section className="cv-box">
            <header><b>Customer confirmation</b></header>
            <p className="muted-sm">{visit.otp_required ? 'The arrival code was checked when the visit started.' : 'This account does not require an OTP at this step.'}</p>
          </section>
          <section className="cv-box">
            <header><b>Signature <span className="muted-sm">(optional)</span></b></header>
            <Signature onChange={setSigned} />
          </section>
          <section className="cv-box">
            <header><b>Next follow-up <span className="muted-sm">(optional)</span></b></header>
            <label className="cv-lbl">Follow-up date<input type="date" value={nextDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setNextDate(e.target.value)} /></label>
          </section>
        </div>
        <div className="cv-right">
          {error && <ErrorNote>{error}</ErrorNote>}
          <label className="cv-lbl"><span>Work / Activity Details <b className="pof-req">*</b></span>
            <textarea rows={3} value={work} onChange={(e) => setWork(e.target.value)} placeholder="What was actually done at the customer's place" autoFocus /></label>
          <div className="cv-two">
            <label className="cv-lbl">Issue / Complaint<textarea rows={3} value={issue} onChange={(e) => setIssue(e.target.value)} placeholder="What the customer reported" /></label>
            <label className="cv-lbl">Resolution<textarea rows={3} value={fix} onChange={(e) => setFix(e.target.value)} placeholder="How it was settled" /></label>
          </div>
          <div className="cv-opt"><label><input type="checkbox" checked={parts} onChange={(e) => setParts(e.target.checked)} /> Parts / Items Used</label>
            {parts && <input value={partsText} onChange={(e) => setPartsText(e.target.value)} placeholder="e.g. 2 × filter, 1 × belt" />}</div>
          <div className="cv-opt"><label><input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> Payment Received</label>
            {paid && <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="Amount in ₹" />}</div>
        </div>
      </div>
    </Dialog>
  )
}
