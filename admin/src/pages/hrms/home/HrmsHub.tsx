/**
 * The Human Resources landing page: one card per HRMS module with a line on
 * what it does, grouped by Time & Attendance, Payroll & Finance and People &
 * Ops. The few figures on it are read from the same endpoints as the HR
 * dashboard; a card with nothing real to show carries no number.
 */

import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { canAdminister, canViewTeam, useAuth } from '../../../lib/auth'
import { money, todayISO } from '../../../lib/format'
import type { ApprovalCounts, User } from '../../../lib/types'
import { HRMS_NAV_ITEMS } from '../../../lib/nav'
import { IconChevronRight, IconClock, IconSheet, IconUsers } from '../../../components/Icons'
import '../../../styles/hrmsHub.css'

type Tab = 'all' | 'time' | 'pay' | 'people'
const TABS: Array<[Tab, string]> = [['all', 'All Modules'], ['time', 'Time & Attendance'], ['pay', 'Payroll & Finance'], ['people', 'People & Ops']]

/** What each module is for, and which tab it belongs to — keyed by its route. */
const MODULES: Record<string, { tab: Exclude<Tab, 'all'>; text: string }> = {
  '/hrms/dashboard': { tab: 'people', text: 'Headcount, joiners, exits, and workforce analytics.' },
  '/attendance': { tab: 'time', text: 'Daily punches, presence logs, and regularization.' },
  '/tracking': { tab: 'time', text: 'Live field check-ins, geo-fencing, and location logs.' },
  '/hrms/leave': { tab: 'time', text: 'Time-off balances, holiday calendar, and leave requests.' },
  '/hrms/working-hours': { tab: 'time', text: 'Shift schedules, overtime, and hours worked across teams.' },
  '/salary': { tab: 'pay', text: 'Salary structures, automated payslips, and tax compliance.' },
  '/expenses': { tab: 'pay', text: 'Employee claims, receipt uploads, and reimbursements.' },
  '/hrms/settings': { tab: 'people', text: 'Policies, probation, document and birthday windows.' },
}

function Stat({ label, value, note, icon, tone }: { label: string; value: ReactNode; note?: ReactNode; icon: ReactNode; tone: string }) {
  return (
    <div className="hh-stat">
      <div><small>{label}</small><b>{value}</b>{note && <span>{note}</span>}</div>
      <i className={`hh-ic is-${tone}`} aria-hidden>{icon}</i>
    </div>
  )
}

const soft = <T,>(run: () => Promise<T>) => () => run().catch(() => null)

export default function HrmsHub() {
  const { user } = useAuth()
  const admin = canAdminister(user)
  const team = canViewTeam(user)
  const today = todayISO()
  const [tab, setTab] = useState<Tab>('all')

  const employees = useQuery('hh-employees', soft(() => api.get<User[]>('/admin/employees')))
  const approvals = useQuery('hh-approvals', soft(() => api.get<ApprovalCounts>('/approvals/counts')))
  const attendance = useQuery(`hh-att-${today}`, soft(() =>
    team ? api.get<Array<{ status: string }>>(`/attendance/team?start=${today}&end=${today}`) : Promise.resolve(null)))
  const payruns = useQuery('hh-payruns', soft(() =>
    admin ? api.get<Array<{ period_year: number; period_month: number; status: string; pay_date: string | null; total_net: number }>>('/payruns') : Promise.resolve(null)))

  const people = (employees.data ?? []).filter((p) => p.is_active && (p.status ?? 'active') !== 'inactive')
  const rows = attendance.data ?? null
  const present = rows ? rows.filter((r) => r.status === 'present' || r.status === 'half_day').length : null
  const latest = [...(payruns.data ?? [])].sort((a, b) => b.period_year * 100 + b.period_month - (a.period_year * 100 + a.period_month))[0]

  const modules = HRMS_NAV_ITEMS
    .filter((i) => MODULES[i.to] && (!i.adminOnly || admin) && (!i.teamOnly || team))
    .filter((i) => tab === 'all' || MODULES[i.to].tab === tab)

  /** The one real figure a card can carry, where there is one. */
  const metric = (to: string): [string, string] | null => {
    if (to === '/hrms/dashboard' && employees.data) return ['Active Employees', String(people.length)]
    if (to === '/attendance' && present !== null) return ['Checked In', String(present)]
    if (to === '/salary' && latest) return [`Latest run · ${latest.status}`, money(latest.total_net)]
    return null
  }

  return (
    <div className="hh">
      <header className="hh-head">
        <span className="hh-bar" aria-hidden />
        <i className="hh-logo" aria-hidden><IconUsers size={22} /></i>
        <div className="hh-title">
          <div className="hh-pills"><span className="hh-pill is-brand">HRMS Suite</span><span className="hh-pill">{Object.keys(MODULES).length} Modules</span></div>
          <h1>Human Resources</h1>
          <p>Attendance, payroll, expenses and the people processes that run every working day.</p>
        </div>
        <nav className="hh-tabs" aria-label="Module groups">
          {TABS.map(([k, label]) => (
            <button key={k} type="button" className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>
              {label}{k === 'all' && <em>{Object.keys(MODULES).length}</em>}
            </button>
          ))}
        </nav>
      </header>

      <section className="hh-stats">
        <Stat label="Total Headcount" value={employees.data ? people.length : '—'} icon={<IconUsers size={18} />} tone="blue" />
        <Stat label="Present Today" value={present ?? '—'} note={rows ? `${present} / ${people.length} in` : undefined} icon={<IconClock size={18} />} tone="green" />
        <Stat label="Pending Approvals" value={approvals.data ? approvals.data.total : '—'}
          note={approvals.data ? `${approvals.data.leave} leave · ${approvals.data.expense} exp` : undefined} icon={<IconSheet size={18} />} tone="amber" />
        <Stat label="Latest Payroll Run" value={latest ? `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][latest.period_month - 1]} ${latest.period_year}` : '—'}
          note={latest?.status} icon={<IconSheet size={18} />} tone="teal" />
      </section>

      <div className="hh-sub"><span>HRMS Workspace Modules</span><span>Showing {modules.length} of {Object.keys(MODULES).length} modules</span></div>
      <div className="hh-grid">
        {modules.map((m) => {
          const Icon = m.icon
          const fig = metric(m.to)
          return (
            <Link key={m.to} to={admin && m.adminTo ? m.adminTo : m.to} className="hh-card">
              <div className="hh-card-top">
                <i className="hh-ic is-brand" aria-hidden><Icon size={18} /></i>
                <span className="hh-go" aria-hidden><IconChevronRight size={14} /></span>
              </div>
              <h3>{m.label === 'Attandance' ? 'Attendance' : m.label}</h3>
              <p>{MODULES[m.to].text}</p>
              {fig && <div className="hh-card-foot"><span>{fig[0]}</span><b>{fig[1]}</b></div>}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
