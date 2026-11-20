/* Salary slips, for administrators: everyone's payslip for a month, or one person's across months. */

import { useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { money } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type { PayRun, PayRunDetail, Payslip, User } from '../../../lib/types'
import { PayslipCard } from './PayRuns'

type Mode = 'month' | 'employee'

export default function SalarySlips() {
  const [mode, setMode] = useState<Mode>('month')
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Salary Slips</h1>
          <p className="muted">Every employee’s payslip, by month or by person.</p>
        </div>
        <div className="ts-toggle" role="group" aria-label="View">
          <button className={`ts-toggle-btn ${mode === 'month' ? 'ts-toggle-on' : ''}`} onClick={() => setMode('month')}>By month</button>
          <button className={`ts-toggle-btn ${mode === 'employee' ? 'ts-toggle-on' : ''}`} onClick={() => setMode('employee')}>By employee</button>
        </div>
      </header>
      {mode === 'month' ? <ByMonth /> : <ByEmployee />}
    </div>
  )
}

function SlipTable({ slips, showEmployee, showPeriod }: { slips: Payslip[]; showEmployee: boolean; showPeriod: boolean }) {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {showEmployee && <th>Employee</th>}
            {showPeriod && <th>Period</th>}
            <th className="num">Gross</th><th className="num">Deductions</th><th className="num">Net</th><th>Status</th><th />
          </tr>
        </thead>
        <tbody>
          {slips.map((s) => (
            <SlipRow key={s.id} slip={s} showEmployee={showEmployee} showPeriod={showPeriod} open={open === s.id}
                     onToggle={() => setOpen(open === s.id ? null : s.id)} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SlipRow({ slip, showEmployee, showPeriod, open, onToggle }: {
  slip: Payslip; showEmployee: boolean; showPeriod: boolean; open: boolean; onToggle: () => void
}) {
  const full = useQuery<Payslip>(`salary-slip-${slip.id}`, () => api.get<Payslip>(`/payruns/payslips/${slip.id}`), { enabled: open })
  const cols = 5 + Number(showEmployee) + Number(showPeriod)
  return (
    <>
      <tr>
        {showEmployee && <td><b>{slip.user_name}</b>{slip.employee_code && <div className="muted-sm">{slip.employee_code}</div>}</td>}
        {showPeriod && <td>{slip.period_label}</td>}
        <td className="num">{money(slip.gross)}</td>
        <td className="num">{money(slip.total_deductions)}</td>
        <td className="num"><strong>{money(slip.net)}</strong></td>
        <td className="muted-sm">{slip.run_status ?? ''}</td>
        <td className="row-actions"><button className="btn small" onClick={onToggle}>{open ? 'Hide' : 'View'}</button></td>
      </tr>
      {open && (
        <tr>
          <td colSpan={cols}>
            {full.error ? <ErrorNote>{full.error}</ErrorNote> : full.data ? <PayslipCard slip={full.data} /> : <Loading />}
          </td>
        </tr>
      )}
    </>
  )
}

function ByMonth() {
  const runs = useQuery<PayRun[]>('salary-slips-runs', () => api.get<PayRun[]>('/payruns'))
  const [runId, setRunId] = useState('')
  const [search, setSearch] = useState('')
  const usable = (runs.data ?? []).filter((r) => r.status !== 'cancelled')
  const chosen = runId || usable[0]?.id || ''
  const detail = useQuery<PayRunDetail>(`salary-slips-run-${chosen}`, () => api.get<PayRunDetail>(`/payruns/${chosen}`), { enabled: Boolean(chosen) })

  if (runs.error) return <ErrorNote>{runs.error}</ErrorNote>
  if (runs.loading && !runs.data) return <Loading />
  if (usable.length === 0) return <Empty>No pay runs yet. Create one under Pay runs, then compute it to build payslips.</Empty>

  const q = search.trim().toLowerCase()
  const slips = (detail.data?.payslips ?? []).filter((s) => !q || (s.user_name ?? '').toLowerCase().includes(q) || (s.employee_code ?? '').toLowerCase().includes(q))
  return (
    <section className="card">
      <div className="card-head" style={{ gap: 12, flexWrap: 'wrap' }}>
        <select value={chosen} onChange={(e) => setRunId(e.target.value)}>
          {usable.map((r) => <option key={r.id} value={r.id}>{r.period_label} · {r.status}</option>)}
        </select>
        <input placeholder="Search employee" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 260 }} />
        <span className="card-note">{slips.length} payslips</span>
      </div>
      {detail.error ? <ErrorNote>{detail.error}</ErrorNote> : !detail.data ? <Loading /> : slips.length === 0 ? (
        <Empty>{detail.data.payslips.length === 0 ? 'Nothing computed for this month yet.' : 'Nobody matches that search.'}</Empty>
      ) : <SlipTable slips={slips} showEmployee showPeriod={false} />}
    </section>
  )
}

function ByEmployee() {
  const people = useQuery<User[]>('salary-slips-people', () => api.get<User[]>('/admin/employees'))
  const [userId, setUserId] = useState('')
  const slips = useQuery<Payslip[]>(`salary-slips-of-${userId}`, () => api.get<Payslip[]>(`/payruns/payslips/of/${userId}`), { enabled: Boolean(userId) })
  return (
    <section className="card">
      <div className="card-head">
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Choose an employee</option>
          {(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
        </select>
      </div>
      {!userId ? <Empty>Choose an employee to see their payslips for every month.</Empty>
        : slips.error ? <ErrorNote>{slips.error}</ErrorNote>
        : !slips.data ? <Loading />
        : slips.data.length === 0 ? <Empty>No payslips for this person yet.</Empty>
        : <SlipTable slips={slips.data} showEmployee={false} showPeriod />}
    </section>
  )
}
