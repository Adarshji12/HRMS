/* Salary setup: the templates a grade is paid on, and the components they are built from. */

import { useEffect, useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { money } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type { PayComponent, StructurePreview } from '../../../lib/types'
import { Dialog } from '../../crm/parts'
import PayComponents from './PayComponents'
import '../../../styles/leavedesk.css'

export interface SalaryTemplate {
  id: string; name: string; description: string | null; is_active: boolean; is_default: boolean; component_ids: string[]
  rules?: Record<string, { calculation: string; rate_bps: number }>
}

export default function SalarySetup() {
  const [tab, setTab] = useState<'structures' | 'components'>('structures')
  return (
    <div className="page">
      <div className="ld-tabs ld-tabs-sm" role="tablist">
        <button className={`ld-tab ${tab === 'structures' ? 'is-on' : ''}`} onClick={() => setTab('structures')}>Structures</button>
        <button className={`ld-tab ${tab === 'components' ? 'is-on' : ''}`} onClick={() => setTab('components')}>Components</button>
      </div>
      {tab === 'structures' ? <Structures /> : <PayComponents />}
    </div>
  )
}

function Structures() {
  const q = useQuery<SalaryTemplate[]>('salary-templates', () => api.get<SalaryTemplate[]>('/payroll/templates'))
  const comps = useQuery<PayComponent[]>('pay-components-all', () => api.get<PayComponent[]>('/payroll/components'))
  const [dlg, setDlg] = useState<SalaryTemplate | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function remove(t: SalaryTemplate) {
    if (!window.confirm(`Delete the structure “${t.name}”? People already paid on it are not affected.`)) return
    try { await api.del(`/payroll/templates/${t.id}`); q.reload() } catch (caught) { setError((caught as Error).message) }
  }

  return (
    <section className="card">
      <div className="card-head" style={{ justifyContent: 'space-between' }}>
        <div>
          <h2 className="card-title">Salary Structures</h2>
          <p className="muted-sm">The template a grade is paid on — set the CTC per person.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setDlg('new')}>+ Add Structure</button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorNote>{q.error}</ErrorNote>
        : !q.data?.length ? <Empty>No structures yet. Add one for each grade, for example Executive or Manager.</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Structure</th><th>Components</th><th>Status</th><th /></tr></thead>
              <tbody>
                {q.data.map((t) => (
                  <tr key={t.id}>
                    <td><b>{t.name}</b>{t.is_default && <span className="pr-pill" style={{ marginLeft: 8 }}>Default</span>}
                      {t.description && <div className="muted-sm">{t.description}</div>}</td>
                    <td>{t.component_ids.length}</td>
                    <td><span className={`pr-status ${t.is_active ? 'pr-status-ok' : 'pr-status-muted'}`}>{t.is_active ? 'Active' : 'Inactive'}</span></td>
                    <td className="row-actions">
                      <button className="btn small" onClick={() => setDlg(t)}>Edit</button>{' '}
                      <button className="btn small danger" onClick={() => remove(t)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {dlg && <StructureDialog existing={dlg === 'new' ? null : dlg} components={comps.data ?? []}
                               onClose={() => setDlg(null)} onSaved={() => { setDlg(null); q.reload() }} />}
    </section>
  )
}

type Rule = { calculation: string; rate: string }
const HOWS = [
  { value: 'percent_of_gross', label: '% of CTC' },
  { value: 'percent_of_basic', label: '% of Basic' },
  { value: 'fixed', label: 'Fixed amount' },
  { value: 'balance', label: 'Balancing figure' },
]
const STATUTORY = /provident|esic|esi\b|professional tax|\btds\b/i

export interface RichPreview extends StructurePreview {
  deductions: { code: string; name: string; amount: number }[]
  employer: { code: string; name: string; amount: number }[]
  net_monthly: number
  notes: string[]
}

function StructureDialog({ existing, components, onClose, onSaved }: {
  existing: SalaryTemplate | null; components: PayComponent[]; onClose: () => void; onSaved: () => void
}) {
  const active = components.filter((c) => c.is_active)
  const earnings = active.filter((c) => c.kind === 'earning')
  const deductions = active.filter((c) => c.kind !== 'earning')
  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [picked, setPicked] = useState<Set<string>>(() => new Set(existing
    ? existing.component_ids
    : earnings.filter((c) => c.calculation !== 'fixed').map((c) => c.id)))
  const [rules, setRules] = useState<Record<string, Rule>>(() => {
    const out: Record<string, Rule> = {}
    for (const c of earnings) {
      const r = existing?.rules?.[c.id]
      out[c.id] = r?.calculation
        ? { calculation: r.calculation, rate: r.rate_bps ? String(r.rate_bps / 100) : '' }
        : { calculation: c.calculation, rate: c.rate_bps ? String(c.rate_bps / 100) : '' }
    }
    return out
  })
  const [isDefault, setIsDefault] = useState(existing?.is_default ?? false)
  const [ctc, setCtc] = useState('50000')
  const [preview, setPreview] = useState<RichPreview | null>(null)
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState<string | null>(null)
  const grossPaise = Math.round(Number(ctc) * 100)
  const rateBps = (c: PayComponent) => {
    const r = rules[c.id]
    return r && (r.calculation === 'percent_of_gross' || r.calculation === 'percent_of_basic') ? Math.round(Number(r.rate || 0) * 100) : 0
  }

  useEffect(() => {
    if (!grossPaise || grossPaise <= 0) { setPreview(null); return }
    const lines = earnings.filter((c) => picked.has(c.id)).map((c) => ({
      component_id: c.id, amount: rules[c.id]?.calculation === 'fixed' ? 0 : null,
      calculation: rules[c.id]?.calculation, rate_bps: rateBps(c),
    }))
    if (!lines.length) { setPreview(null); return }
    const t = setTimeout(async () => {
      try { setPreview(await api.post<RichPreview>('/payroll/preview', { gross_monthly: grossPaise, components: lines })); setPreviewErr(null) }
      catch (caught) { setPreview(null); setPreviewErr((caught as Error).message) }
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grossPaise, picked, rules, components])

  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const setRule = (id: string, patch: Partial<Rule>) => setRules((r) => ({ ...r, [id]: { ...r[id], ...patch } }))

  async function save() {
    setBusy(true); setFail(null)
    const ruleBody: Record<string, { calculation: string; rate_bps: number }> = {}
    for (const c of earnings) if (picked.has(c.id)) ruleBody[c.id] = { calculation: rules[c.id].calculation, rate_bps: rateBps(c) }
    const body = { name: name.trim(), description: description.trim() || null, component_ids: [...picked], rules: ruleBody, is_active: true, is_default: isDefault }
    try {
      if (existing) await api.put(`/payroll/templates/${existing.id}`, body)
      else await api.post('/payroll/templates', body)
      onSaved()
    } catch (caught) { setFail((caught as Error).message) } finally { setBusy(false) }
  }

  const dim = { opacity: 0.5 } as const
  const cell = { height: 38 } as const
  return (
    <Dialog title={existing ? 'Edit Salary Structure' : 'Add Salary Structure'} wide onClose={onClose}
            footer={<>
              <label className="pr-check" style={{ marginRight: 'auto' }}>
                <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
                <span>Offer this structure first when assigning a salary</span>
              </label>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !name.trim() || picked.size === 0} onClick={save}>
                {busy ? 'Saving…' : existing ? 'Save' : 'Add'}
              </button>
            </>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.7fr) minmax(250px,1fr)', gap: 20, padding: '8px 24px 20px', flex: 1, minHeight: 0, overflowY: 'auto', alignContent: 'start' }}>
        <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <label className="pr-field"><span className="pr-field-label">Name</span>
              <input value={name} placeholder="Executive Grade" onChange={(e) => setName(e.target.value)} /></label>
            <label className="pr-field"><span className="pr-field-label">Description</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
          </div>
          <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 12 }}>
            <table className="table">
              <thead><tr><th style={{ width: 28 }} /><th>Component</th><th>How</th><th>Value</th></tr></thead>
              <tbody>
                {earnings.map((c) => {
                  const on = picked.has(c.id)
                  const r = rules[c.id]
                  const pctRule = r.calculation === 'percent_of_gross' || r.calculation === 'percent_of_basic'
                  return (
                    <tr key={c.id} style={on ? undefined : dim}>
                      <td><input type="checkbox" checked={on} onChange={() => toggle(c.id)} aria-label={`Include ${c.name}`} /></td>
                      <td>{c.name}<div className="muted-sm" style={{ color: '#0f9d6a' }}>Earning</div></td>
                      <td>
                        <select value={r.calculation} disabled={!on} style={cell}
                                onChange={(e) => setRule(c.id, { calculation: e.target.value })}>
                          {HOWS.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
                        </select>
                      </td>
                      <td>
                        {pctRule ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <input type="number" data-spin min={0} step="any" value={r.rate} disabled={!on} style={{ width: 64, ...cell }}
                                   onChange={(e) => setRule(c.id, { rate: e.target.value })} />%
                          </span>
                        ) : <span className="muted-sm">{r.calculation === 'balance' ? 'remainder' : 'per person'}</span>}
                      </td>
                    </tr>
                  )
                })}
                {deductions.map((c) => {
                  const locked = STATUTORY.test(c.name)
                  return (
                    <tr key={c.id} style={locked ? dim : { opacity: 0.55 }}>
                      <td><input type="checkbox" checked={locked} disabled aria-label={c.name} /></td>
                      <td>{c.name}{locked && ' 🔒'}<div className="muted-sm" style={{ color: '#c0262b' }}>Deduction</div></td>
                      <td className="muted">{locked ? 'Statutory' : 'Entered each month'}</td>
                      <td className="muted-sm">monthly</td>
                    </tr>
                  )
                })}
                {['PF (Employer)', 'ESIC (Employer)'].map((n) => (
                  <tr key={n} style={dim}>
                    <td><input type="checkbox" checked disabled aria-label={n} /></td>
                    <td>{n} 🔒<div className="muted-sm">Employer Contribution</div></td>
                    <td className="muted">Statutory</td><td className="muted-sm">monthly</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {fail && <ErrorNote>{fail}</ErrorNote>}
        </div>
        <aside style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 16, background: 'var(--surface-2)', alignSelf: 'start' }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Preview at a monthly CTC of</div>
          <input type="number" data-spin min={0} value={ctc} onChange={(e) => setCtc(e.target.value)} style={{ width: '100%', marginBottom: 12 }} />
          {previewErr ? <p className="muted-sm" style={{ color: '#b45309' }}>{previewErr}</p>
            : !preview ? <p className="muted-sm">Pick at least one earning to see the split.</p> : (
              <table className="table" style={{ background: 'transparent' }}>
                <tbody>
                  {preview.components.map((l) => <tr key={l.component_id}><td>{l.name}</td><td className="num">{money(l.amount)}</td></tr>)}
                  <tr className="pr-total-row"><td>Gross</td><td className="num">{money(preview.gross_monthly)}</td></tr>
                  {preview.deductions.map((l) => <tr key={l.code}><td>{l.name}</td><td className="num" style={{ color: '#e5484d' }}>-{money(l.amount)}</td></tr>)}
                  <tr className="pr-total-row"><td>Net pay</td><td className="num" style={{ color: '#0f9d6a' }}>{money(preview.net_monthly)}</td></tr>
                </tbody>
              </table>
            )}
          {preview?.notes.map((n, i) => <p key={i} className="muted-sm" style={{ color: n.startsWith('ESIC') ? '#b45309' : undefined }}>{n}</p>)}
        </aside>
      </div>
    </Dialog>
  )
}
