/* Sales targets: who has a target this month, what they achieved and what it earned.

   The rule itself (default target, incentive, approval) lives in HR Settings → Sales Target. This page
   only assigns targets per person per month and raises the incentives. */

import { useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import { Dialog } from '../../crm/parts'
import '../../../styles/payroll.css'

interface Rule { is_enabled: boolean; target_type: string }
interface TargetRow { user_id: string; name: string; target: number; is_set: boolean; achieved: number; earned: number }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const inr = (n: number) => Math.round(n).toLocaleString('en-IN')

export default function SalesTargets() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const rule = useQuery<Rule>('incentive-rule', () => api.get<Rule>('/incentives/rule'))
  const q = useQuery<TargetRow[]>(`incentive-targets-${year}-${month}`, () => api.get<TargetRow[]>(`/incentives/targets?year=${year}&month=${month}`))
  const [dlg, setDlg] = useState<TargetRow | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const sales = rule.data?.target_type === 'sales'
  const on = Boolean(rule.data?.is_enabled)
  const assigned = (q.data ?? []).filter((r) => r.is_set)
  const years = [year - 2, year - 1, year, year + 1].filter((v, i, a) => a.indexOf(v) === i)

  function step(delta: number) {
    const d = new Date(year, month - 1 + delta, 1)
    setYear(d.getFullYear()); setMonth(d.getMonth() + 1)
  }

  async function setTarget(userId: string, value: number | null) {
    setError(null)
    await api.put('/incentives/targets', { year, month, targets: [{ user_id: userId, target: value }] })
    q.reload()
  }

  async function raise() {
    setBusy(true); setError(null); setMessage(null)
    try {
      const rows = await api.post<unknown[]>('/incentives/evaluate', { year, month })
      setMessage(rows.length === 0 ? 'Nobody has earned an incentive for this month yet.'
        : `${rows.length} incentive${rows.length === 1 ? '' : 's'} raised. Those needing approval are in the Approvals queue.`)
      q.reload()
    } catch (caught) { setError((caught as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="page">
      {rule.data && !on && (
        <div className="notice" style={{ marginBottom: 14, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 12, padding: '14px 18px' }}>
          <b>Sales targets are switched off</b>
          <p className="muted-sm" style={{ margin: '6px 0 0' }}>Turn them on in HR Settings → Sales Target, where the default target, the incentive and the approval rule are set.</p>
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {message && <div className="notice notice-ok" style={{ marginBottom: 12 }}>{message}</div>}
      <section className="card">
        <div className="card-head" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn small" onClick={() => step(-1)} aria-label="Previous month">‹</button>
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))} aria-label="Month">
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            <select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year">
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <button className="btn small" onClick={() => step(1)} aria-label="Next month">›</button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {assigned.length > 0 && on && <button className="btn" disabled={busy} onClick={() => void raise()}>Raise incentives</button>}
            <button className="btn btn-primary" disabled={!on} onClick={() => setDlg('new')}>+ Assign target</button>
          </div>
        </div>
        {q.loading && !q.data ? <Loading /> : q.error ? <ErrorNote>{q.error}</ErrorNote> : assigned.length === 0 ? (
          <Empty>
            <b>No targets for this month</b>
            <p className="muted-sm">Assign one to an employee. Assigning earns nothing on its own — the incentive appears when you record an achievement that meets the rule.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Employee</th><th className="num">Target</th><th className="num">Achieved</th><th className="num">Earned</th><th /></tr></thead>
              <tbody>
                {assigned.map((r) => (
                  <tr key={r.user_id}>
                    <td><b>{r.name}</b></td>
                    <td className="num">{sales ? `₹${inr(r.target)}` : r.target}</td>
                    <td className="num">{sales ? `₹${inr(r.achieved)}` : r.achieved}</td>
                    <td className="num">{r.earned ? `₹${inr(r.earned / 100)}` : '—'}</td>
                    <td className="row-actions">
                      <button className="btn small" onClick={() => setDlg(r)}>Edit</button>{' '}
                      <button className="btn small danger" onClick={() => void setTarget(r.user_id, null).catch((c) => setError((c as Error).message))}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-head" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--border)' }}>
          <span className="muted-sm">{assigned.length} target{assigned.length === 1 ? '' : 's'}</span>
          <span className="muted-sm">An approved incentive is added to that month’s payslip under Earnings.</span>
        </div>
      </section>
      {dlg && (
        <AssignDialog rows={q.data ?? []} existing={dlg === 'new' ? null : dlg} sales={sales} month={`${MONTHS[month - 1]} ${year}`}
                      onClose={() => setDlg(null)}
                      onSave={async (id, v) => { await setTarget(id, v); setDlg(null) }} />
      )}
    </div>
  )
}

function AssignDialog({ rows, existing, sales, month, onClose, onSave }: {
  rows: TargetRow[]; existing: TargetRow | null; sales: boolean; month: string
  onClose: () => void; onSave: (userId: string, value: number) => Promise<void>
}) {
  const choices = existing ? [existing] : rows.filter((r) => !r.is_set)
  const [userId, setUserId] = useState(existing?.user_id ?? '')
  const [value, setValue] = useState(existing ? String(existing.target) : '')
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState<string | null>(null)
  const n = Number(value)
  const bad = !userId || value.trim() === '' || !Number.isFinite(n) || n < 0

  async function go() {
    setBusy(true); setFail(null)
    try { await onSave(userId, n) } catch (caught) { setFail((caught as Error).message); setBusy(false) }
  }

  return (
    <Dialog title={existing ? 'Edit target' : 'Assign target'} subtitle={month} narrow onClose={onClose}
            footer={<>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || bad} onClick={() => void go()}>{busy ? 'Saving…' : 'Save'}</button>
            </>}>
      <div style={{ display: 'grid', gap: 16, padding: '8px 24px 20px' }}>
        <label className="pr-field"><span className="pr-field-label">Employee</span>
          <select value={userId} disabled={Boolean(existing)} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose an employee</option>
            {choices.map((r) => <option key={r.user_id} value={r.user_id}>{r.name}</option>)}
          </select>
        </label>
        <label className="pr-field"><span className="pr-field-label">{sales ? 'Sales target (₹)' : 'Target (customers)'}</span>
          <input type="number" data-spin min={0} step={1} value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        {fail && <ErrorNote>{fail}</ErrorNote>}
      </div>
    </Dialog>
  )
}
