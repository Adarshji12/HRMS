/* Salary setup: the templates a grade is paid on, and the components they are built from. */

import { useEffect, useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { money } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type { PayComponent, StructurePreview } from '../../../lib/types'
import { Dialog } from '../../crm/parts'
import PayComponents from './PayComponents'
import { ruleOf } from './SalaryStructures'
import '../../../styles/leavedesk.css'

export interface SalaryTemplate {
  id: string; name: string; description: string | null; is_active: boolean; is_default: boolean; component_ids: string[]
}

export default function SalarySetup() {
  const [tab, setTab] = useState<'structures' | 'components'>('structures')
  return (
    <div className="page">
      <div className="ld-tabs" role="tablist">
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

function StructureDialog({ existing, components, onClose, onSaved }: {
  existing: SalaryTemplate | null; components: PayComponent[]; onClose: () => void; onSaved: () => void
}) {
  const earnings = components.filter((c) => c.kind === 'earning' && c.is_active)
  const others = components.filter((c) => c.kind !== 'earning' && c.is_active)
  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [picked, setPicked] = useState<Set<string>>(() => new Set(existing ? existing.component_ids : components.filter((c) => c.kind === 'earning' && c.is_active && c.calculation !== 'fixed').map((c) => c.id)))
  const [isDefault, setIsDefault] = useState(existing?.is_default ?? false)
  const [ctc, setCtc] = useState('50000')
  const [preview, setPreview] = useState<StructurePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState<string | null>(null)
  const grossPaise = Math.round(Number(ctc) * 100)

  useEffect(() => {
    if (!grossPaise || grossPaise <= 0) { setPreview(null); return }
    const lines = earnings.filter((c) => picked.has(c.id)).map((c) => ({ component_id: c.id, amount: c.calculation === 'fixed' ? 0 : null }))
    if (!lines.length) { setPreview(null); return }
    const t = setTimeout(async () => {
      try { setPreview(await api.post<StructurePreview>('/payroll/preview', { gross_monthly: grossPaise, components: lines })) }
      catch { setPreview(null) }
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grossPaise, picked, components])

  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })

  async function save() {
    setBusy(true); setFail(null)
    const body = { name: name.trim(), description: description.trim() || null, component_ids: [...picked], is_active: true, is_default: isDefault }
    try {
      if (existing) await api.put(`/payroll/templates/${existing.id}`, body)
      else await api.post('/payroll/templates', body)
      onSaved()
    } catch (caught) { setFail((caught as Error).message) } finally { setBusy(false) }
  }

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
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.7fr) minmax(240px,1fr)', gap: 20, padding: '8px 24px 20px' }}>
        <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <label className="pr-field"><span className="pr-field-label">Name</span>
              <input value={name} placeholder="Executive Grade" onChange={(e) => setName(e.target.value)} /></label>
            <label className="pr-field"><span className="pr-field-label">Description</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
          </div>
          <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 12 }}>
            <table className="table">
              <thead><tr><th /><th>Component</th><th>How</th><th>Value</th></tr></thead>
              <tbody>
                {earnings.map((c) => (
                  <tr key={c.id} style={{ opacity: picked.has(c.id) ? 1 : 0.55 }}>
                    <td><input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Include ${c.name}`} /></td>
                    <td>{c.name}<div className="muted-sm" style={{ color: '#0f9d6a' }}>Earning</div></td>
                    <td className="muted">{ruleOf(c)}</td>
                    <td className="muted-sm">{c.calculation === 'fixed' ? 'per person' : c.calculation === 'balance' ? 'remainder' : ''}</td>
                  </tr>
                ))}
                {others.map((c) => (
                  <tr key={c.id} style={{ opacity: 0.5 }}>
                    <td><input type="checkbox" checked disabled aria-label={c.name} /></td>
                    <td>{c.name}<div className="muted-sm" style={{ color: '#c0262b' }}>Deduction</div></td>
                    <td className="muted">{c.calculation === 'fixed' ? 'entered each month' : ruleOf(c)}</td>
                    <td className="muted-sm">applied at payroll</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {fail && <ErrorNote>{fail}</ErrorNote>}
        </div>
        <aside style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 16, background: 'var(--surface-2)', alignSelf: 'start' }}>
          <div className="pr-field-label" style={{ marginBottom: 8 }}>Preview at a monthly CTC of</div>
          <input type="number" data-spin min={0} value={ctc} onChange={(e) => setCtc(e.target.value)} style={{ width: '100%', marginBottom: 12 }} />
          {!preview ? <p className="muted-sm">Pick at least one earning to see the split.</p> : (
            <table className="table" style={{ background: 'transparent' }}>
              <tbody>
                {preview.components.map((l) => <tr key={l.component_id}><td>{l.code}</td><td className="num">{money(l.amount)}</td></tr>)}
                <tr className="pr-total-row"><td>Gross</td><td className="num">{money(preview.gross_monthly)}</td></tr>
              </tbody>
            </table>
          )}
        </aside>
      </div>
    </Dialog>
  )
}
