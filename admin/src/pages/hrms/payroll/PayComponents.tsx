/* Salary components: the heads the company pays and deducts under.

   The statutory checkboxes are the point of this screen, not the percentages. PF wages, ESIC
   wages and taxable are the whole interface between a company's salary design and statutory
   computation; nothing downstream infers them from a name.

   Server rules this form explains rather than hides: exactly one component is the basic (percent
   of basic refers to it), and exactly one earning absorbs the balance of gross. Editing a
   component changes the next structure built from it, never an existing one. */

import { useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type { Calculation, PayComponent } from '../../../lib/types'
import { Dialog } from '../../crm/parts'
import { pct, ruleOf } from './SalaryStructures'
import '../../../styles/payroll.css'

const CALCULATIONS: { value: Calculation; label: string }[] = [
  { value: 'fixed', label: 'Fixed amount' },
  { value: 'percent_of_gross', label: '% of CTC' },
  { value: 'percent_of_basic', label: '% of Basic' },
  { value: 'balance', label: 'Balancing figure' },
]

const how = (c: PayComponent) =>
  c.calculation === 'percent_of_gross' ? `% of CTC · ${pct(c.rate_bps)}`
    : c.calculation === 'percent_of_basic' ? `% of Basic · ${pct(c.rate_bps)}`
      : c.calculation === 'balance' ? 'Balancing figure'
        : ruleOf(c).replace(/^./, (x) => x.toUpperCase())

const BLANK = {
  name: '', kind: 'earning', calculation: 'fixed' as Calculation, rate: '',
  is_pf_wage: false, is_esi_wage: true, is_taxable: true, is_active: true,
}

function codeOf(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'COMP'
}

export default function PayComponents() {
  const listQ = useQuery<PayComponent[]>('pay-components-all', () => api.get<PayComponent[]>('/payroll/components'))
  const [dlg, setDlg] = useState<PayComponent | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function remove(c: PayComponent) {
    setError(null)
    try {
      // A component a structure already used can only be switched off, never deleted.
      await api.patch(`/payroll/components/${c.id}`, { is_active: !c.is_active })
      listQ.reload()
    } catch (caught) { setError((caught as Error).message) }
  }

  return (
    <section className="card">
      <div className="card-head" style={{ justifyContent: 'space-between' }}>
        <div>
          <h2 className="card-title">Salary Components</h2>
          <p className="muted-sm">The heads the company pays and deducts under.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setDlg('new')}>+ Add Component</button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {listQ.loading && !listQ.data ? <Loading /> : listQ.error ? <ErrorNote>{listQ.error}</ErrorNote>
        : !listQ.data?.length ? <Empty>No components yet. Add Basic, HRA and a special allowance to begin.</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Component</th><th>Type</th><th>How it is worked out</th><th>PF / ESIC</th><th /></tr></thead>
              <tbody>
                {listQ.data.map((c) => (
                  <tr key={c.id} className={c.is_active ? '' : 'is-off'}>
                    <td>{c.name}{c.is_basic && <span className="pr-pill" style={{ marginLeft: 8 }}>Basic</span>}</td>
                    <td><span className={`pr-status ${c.kind === 'earning' ? 'pr-status-ok' : 'pr-status-bad'}`}>{c.kind === 'earning' ? 'Earning' : 'Deduction'}</span></td>
                    <td className="muted">{how(c)}</td>
                    <td className="muted-sm">{[c.is_pf_wage && 'PF', c.is_esi_wage && 'ESIC'].filter(Boolean).join(' · ') || '–'}</td>
                    <td className="row-actions">
                      <button className="btn small" onClick={() => setDlg(c)}>Edit</button>{' '}
                      <button className="btn small" onClick={() => remove(c)}>{c.is_active ? 'Deactivate' : 'Reactivate'}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      <p className="muted-sm" style={{ padding: '10px 18px' }}>
        Editing a component changes the next structure built from it, never an existing one.
      </p>
      {dlg && <ComponentDialog existing={dlg === 'new' ? null : dlg} onClose={() => setDlg(null)}
                               onSaved={() => { setDlg(null); listQ.reload() }} />}
    </section>
  )
}

function ComponentDialog({ existing, onClose, onSaved }: { existing: PayComponent | null; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState(() => existing ? {
    name: existing.name, kind: existing.kind as string, calculation: existing.calculation,
    rate: existing.rate_bps ? String(existing.rate_bps / 100) : '', is_pf_wage: existing.is_pf_wage,
    is_esi_wage: existing.is_esi_wage, is_taxable: existing.is_taxable, is_active: existing.is_active,
  } : { ...BLANK })
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState<string | null>(null)
  const needsRate = d.calculation === 'percent_of_basic' || d.calculation === 'percent_of_gross'
  const rateBps = d.rate.trim() ? Math.round(Number(d.rate) * 100) : 0
  const rateBad = needsRate && (!Number.isFinite(rateBps) || rateBps <= 0)
  const flip = (k: 'is_pf_wage' | 'is_esi_wage' | 'is_taxable' | 'is_active') => (e: React.ChangeEvent<HTMLInputElement>) => setD({ ...d, [k]: e.target.checked })

  async function save() {
    setBusy(true); setFail(null)
    const body = {
      name: d.name.trim(), kind: d.kind, calculation: d.calculation, rate_bps: needsRate ? rateBps : 0,
      is_pf_wage: d.is_pf_wage, is_esi_wage: d.is_esi_wage, is_taxable: d.is_taxable, is_active: d.is_active,
    }
    try {
      if (existing) await api.patch(`/payroll/components/${existing.id}`, body)
      else await api.post('/payroll/components', { ...body, code: codeOf(d.name), is_basic: false, sort_order: 100 })
      onSaved()
    } catch (caught) { setFail((caught as Error).message) } finally { setBusy(false) }
  }

  return (
    <Dialog title={existing ? 'Edit Component' : 'Add Component'} narrow onClose={onClose}
            footer={<>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !d.name.trim() || rateBad} onClick={save}>
                {busy ? 'Saving…' : existing ? 'Save' : 'Add'}
              </button>
            </>}>
      <div style={{ display: 'grid', gap: 16, padding: '8px 24px 20px' }}>
        <label className="pr-field"><span className="pr-field-label">Name</span>
          <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <label className="pr-field"><span className="pr-field-label">Type</span>
            <select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value })}>
              <option value="earning">Earning</option>
              <option value="deduction">Deduction</option>
            </select>
          </label>
          <label className="pr-field"><span className="pr-field-label">How it is worked out</span>
            <select value={d.calculation} onChange={(e) => setD({ ...d, calculation: e.target.value as Calculation })}>
              {CALCULATIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>
        {needsRate && (
          <label className="pr-field"><span className="pr-field-label">Rate %</span>
            <input type="number" data-spin min={0} step="any" value={d.rate} className={rateBad ? 'is-bad' : ''}
                   onChange={(e) => setD({ ...d, rate: e.target.value })} />
          </label>
        )}
        <div style={{ display: 'grid', gap: 12, padding: 16, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface-2)' }}>
          <label className="pr-check"><input type="checkbox" checked={d.is_pf_wage} onChange={flip('is_pf_wage')} /><span>Counts towards the PF wage</span></label>
          <label className="pr-check"><input type="checkbox" checked={d.is_esi_wage} onChange={flip('is_esi_wage')} /><span>Counts towards the ESIC wage</span></label>
          <label className="pr-check"><input type="checkbox" checked={d.is_taxable} onChange={flip('is_taxable')} /><span>Taxable</span></label>
          <label className="pr-check"><input type="checkbox" checked={d.is_active} onChange={flip('is_active')} /><span>Active</span></label>
        </div>
        {fail && <ErrorNote>{fail}</ErrorNote>}
      </div>
    </Dialog>
  )
}
