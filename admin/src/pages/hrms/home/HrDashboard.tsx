/* HR Dashboard — the whole of HR on one screen.
 *
 * There is no single HR summary endpoint, so this page reads the ones each
 * module already serves — employees, departments, today's attendance, the
 * approvals counts, leave, onboarding, exits, probation, documents, payroll,
 * helpdesk — and lays them out as one overview.
 *
 * Every read is soft: a call the viewer has no right to, or one that fails,
 * empties only its own card ("Not available") instead of taking the page
 * down. Admin-only reads are not even attempted for somebody who is not one,
 * so a manager does not fill the network tab with refusals.
 */

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import '../../../styles/hrdash.css'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { canAdminister, canViewTeam, useAuth } from '../../../lib/auth'
import { money, shortDate, todayISO } from '../../../lib/format'
import type { ApprovalCounts, Department, EmployeeDocument, EmployeeProfile, User } from '../../../lib/types'
import { Avatar, Loading } from '../../../components/ui'
import { Donut, type Slice } from '../../../components/charts'
import {
  IconAlert, IconBuilding, IconCheck, IconChevronRight, IconClock, IconLifebuoy, IconMail,
  IconPlus, IconReturn, IconSheet, IconUsers,
} from '../../../components/Icons'

/* ------------------------------------------------------------- shapes --- */

interface DayRow {
  user_id?: string
  date: string
  status: string
  is_late: boolean
  user_name: string | null
}

interface LeaveOverview {
  headcount: number
  on_leave: Array<{
    user_id: string; user_name: string; leave_type_name: string
    start_date: string; end_date: string; is_half_day: boolean
  }>
}

interface Onboarding {
  id: string; user_name: string | null; designation_name: string | null; joining_date: string
  status: string; total_tasks: number; closed_tasks: number; overdue_tasks: number
}

interface ExitRequest {
  id: string; user_name: string | null; designation_name: string | null
  last_working_day: string | null; status: string; task_total: number; task_settled: number
  blocking_task_count: number
}

interface PayRun {
  id: string; period_year: number; period_month: number; status: string
  pay_date: string | null; total_net: number; employee_count: number
}

interface Ticket { id: string; status: string; priority: string }

/* ------------------------------------------------------------ helpers --- */

/** Resolve to null on any failure — see the note at the top. */
const soft = <T,>(run: () => Promise<T>) => () => run().catch(() => null)

const plusDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/* ============================================================= the page === */

export default function HrDashboard() {
  const { user } = useAuth()
  const admin = canAdminister(user)
  const team = canViewTeam(user)
  const today = todayISO()
  const now = new Date()

  const employees = useQuery('hrd-employees', soft(() => api.get<User[]>('/admin/employees')))
  const departments = useQuery('hrd-departments', soft(() => api.get<Department[]>('/org/departments')))
  const attendance = useQuery(`hrd-att-${today}`, soft(() =>
    team ? api.get<DayRow[]>(`/attendance/team?start=${today}&end=${today}`) : Promise.resolve(null)))
  const approvals = useQuery('hrd-approvals', soft(() => api.get<ApprovalCounts>('/approvals/counts')))
  const leave = useQuery(`hrd-leave-${today}`, soft(() =>
    team
      ? api.get<LeaveOverview>(
        `/leave/overview?year=${now.getFullYear()}&month=${now.getMonth() + 1}&window_start=${today}&window_end=${plusDays(today, 7)}`)
      : Promise.resolve(null)))
  const onboarding = useQuery('hrd-onboarding', soft(() =>
    admin ? api.get<Onboarding[]>('/onboarding/instances') : Promise.resolve(null)))
  const exits = useQuery('hrd-exits', soft(() =>
    admin ? api.get<ExitRequest[]>('/offboarding/requests?open_only=true') : Promise.resolve(null)))
  // The warning windows come from HR Settings → General.
  const hrs = useQuery('hrd-settings', soft(() =>
    api.get<{ probation_warn_days: number; document_warn_days: number }>('/hr/settings')))
  const probWin = hrs.data?.probation_warn_days ?? 30
  const docWin = hrs.data?.document_warn_days ?? 60
  const probation = useQuery(`hrd-probation-${hrs.loading ? "wait" : probWin}`, soft(() =>
    admin && !hrs.loading
      ? api.get<EmployeeProfile[]>(`/people/reports/probation-due?within_days=${probWin}`)
      : Promise.resolve(null)))
  const documents = useQuery(`hrd-documents-${hrs.loading ? "wait" : docWin}`, soft(() =>
    admin && !hrs.loading
      ? api.get<EmployeeDocument[]>(`/people/reports/documents-expiring?within_days=${docWin}`)
      : Promise.resolve(null)))
  const payruns = useQuery('hrd-payruns', soft(() =>
    admin ? api.get<PayRun[]>('/payruns') : Promise.resolve(null)))
  const tickets = useQuery('hrd-tickets', soft(() =>
    team ? api.get<Ticket[]>('/helpdesk/staff/tickets?open_only=true') : Promise.resolve(null)))

  if (employees.loading && !employees.data) return <Loading label="Building the HR overview…" />

  /* ---- derived figures ---- */
  const people = employees.data ?? []
  const active = people.filter((p) => p.is_active && (p.status ?? 'active') !== 'inactive')
  const headcount = active.length
  const monthKey = today.slice(0, 7)
  const joinedThisMonth = people.filter((p) => p.joined_on?.startsWith(monthKey))
  const preJoining = people.filter((p) => p.status === 'pending_setup').length

  const rows = attendance.data ?? null
  const present = rows ? rows.filter((r) => r.status === 'present' || r.status === 'half_day') : []
  const late = present.filter((r) => r.is_late).length
  const onLeaveRows = rows ? rows.filter((r) => r.status === 'on_leave').length : 0
  const absent = rows ? rows.filter((r) => r.status === 'absent').length : 0
  const marked = present.length + onLeaveRows + absent
  const notMarked = Math.max(0, headcount - marked)

  const away = leave.data?.on_leave ?? []
  const awayToday = away.filter((a) => a.start_date <= today && a.end_date >= today)

  const openOnboarding = (onboarding.data ?? []).filter((o) => o.status !== 'completed' && o.status !== 'cancelled')
  const openExits = exits.data ?? []
  const latestRun = [...(payruns.data ?? [])]
    .sort((a, b) => b.period_year * 100 + b.period_month - (a.period_year * 100 + a.period_month))[0]
  const openTickets = tickets.data ?? null

  const kpis: Array<{ label: string; value: ReactNode; hint: string; tone: string; to?: string; icon: ReactNode }> = [
    { label: 'Headcount', value: headcount, hint: preJoining ? `${preJoining} pre-joining` : 'Active employees', tone: 'brand', to: '/employees', icon: <IconUsers size={16} /> },
    { label: 'New joiners', value: joinedThisMonth.length, hint: `Joined in ${MONTHS[now.getMonth()]}`, tone: 'good', to: '/hrms/joiners-letters', icon: <IconPlus size={16} /> },
    { label: 'Present today', value: rows ? present.length : '—', hint: rows ? `${late} late · ${headcount ? Math.round((present.length / headcount) * 100) : 0}% in` : 'Not available', tone: 'good', to: team ? '/attendance/team' : undefined, icon: <IconCheck size={16} /> },
    { label: 'On leave today', value: leave.data ? awayToday.length : rows ? onLeaveRows : '—', hint: `${away.length} away in the next 7 days`, tone: 'warn', to: team ? '/workforce' : undefined, icon: <IconReturn size={16} /> },
    { label: 'Pending approvals', value: approvals.data?.total ?? '—', hint: 'Waiting on a decision', tone: (approvals.data?.total ?? 0) > 0 ? 'bad' : 'idle', to: '/approvals', icon: <IconClock size={16} /> },
    { label: 'Exits in progress', value: exits.data ? openExits.length : '—', hint: exits.data ? 'Open offboarding' : 'Admins only', tone: 'idle', to: admin ? '/offboarding' : undefined, icon: <IconSheet size={16} /> },
  ]

  const slices: Slice[] = [
    { key: 'present', label: 'Present', value: present.length - late, color: 'var(--status-good)' },
    { key: 'late', label: 'Late', value: late, color: 'var(--status-warn)' },
    { key: 'leave', label: 'On leave', value: onLeaveRows, color: 'var(--series-2, var(--brand))' },
    { key: 'absent', label: 'Absent', value: absent, color: 'var(--status-critical)' },
    { key: 'none', label: 'Not marked', value: notMarked, color: 'var(--neutral-mark, var(--border-strong))' },
  ]

  const depts = [...(departments.data ?? [])].filter((d) => d.is_active).sort((a, b) => b.member_count - a.member_count)
  const deptMax = Math.max(1, ...depts.map((d) => d.member_count))

  const approvalRows = [
    { key: 'leave', label: 'Leave applications', value: approvals.data?.leave ?? 0 },
    { key: 'regularization', label: 'Attendance corrections', value: approvals.data?.regularization ?? 0 },
    { key: 'timesheet', label: 'Timesheets', value: approvals.data?.timesheet ?? 0 },
    { key: 'expense', label: 'Expense claims', value: approvals.data?.expense ?? 0 },
    { key: 'loan', label: 'Loans & advances', value: approvals.data?.loan ?? 0 },
  ]

  const recent = [...people]
    .filter((p) => p.joined_on)
    .sort((a, b) => (b.joined_on ?? '').localeCompare(a.joined_on ?? ''))
    .slice(0, 6)

  const dateLine = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div className="hrd">
      {/* ------------------------------------------------------------ hero */}
      <header className="hrd-hero">
        <div className="hrd-hero-text">
          <span className="hrd-eyebrow">HRMS · {dateLine}</span>
          <h1 className="hrd-title">HR Dashboard</h1>
          <p className="hrd-sub">
            Your people at a glance — who is in today, what is waiting on a decision, who is joining and who is leaving.
          </p>
        </div>
        <div className="hrd-hero-actions">
          <Link className="btn" to="/approvals">
            Approvals
            {(approvals.data?.total ?? 0) > 0 && <span className="hrd-pill-count">{approvals.data!.total}</span>}
          </Link>
          {admin && (
            <Link className="btn btn-primary" to="/employees/new">
              <IconPlus size={15} /> Add employee
            </Link>
          )}
        </div>
      </header>

      {/* ------------------------------------------------------------- kpis */}
      <div className="hrd-kpis" role="group" aria-label="HR summary">
        {kpis.map((k) => {
          const body = (
            <>
              <span className="hrd-kpi-top">
                <span className="hrd-kpi-label">{k.label}</span>
                <span className="hrd-kpi-icon" aria-hidden>{k.icon}</span>
              </span>
              <span className="hrd-kpi-value">{k.value}</span>
              <span className="hrd-kpi-hint">{k.hint}</span>
            </>
          )
          return k.to
            ? <Link key={k.label} to={k.to} className={`hrd-kpi tone-${k.tone}`}>{body}</Link>
            : <div key={k.label} className={`hrd-kpi tone-${k.tone}`}>{body}</div>
        })}
      </div>

      {/* ------------------------------------------- attendance + departments */}
      <div className="hrd-row hrd-row-2">
        <Panel title="Today’s attendance" note={rows ? `${marked} of ${headcount} accounted for` : undefined}
               link={team ? { to: '/attendance/team', label: 'Team attendance' } : undefined}>
          {!rows ? <NA what="Attendance is visible to managers and administrators." /> : (
            <div className="hrd-att">
              <Donut slices={slices} total={present.length} caption="present" unit="people" size={176} />
              <ul className="hrd-legend">
                {slices.map((s) => (
                  <li key={s.key}>
                    <span className="hrd-swatch" style={{ background: s.color }} aria-hidden />
                    <span className="hrd-legend-name">{s.label}</span>
                    <span className="hrd-legend-value">{s.value}</span>
                    <span className="hrd-legend-pct">{headcount ? Math.round((s.value / headcount) * 100) : 0}%</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>

        <Panel title="Headcount by department" note={depts.length ? `${depts.length} departments` : undefined}
               link={{ to: '/departments', label: 'Departments' }}>
          {!departments.data ? <NA /> : depts.length === 0 ? (
            <p className="hrd-empty">No departments yet. Create them under Master → Organisation.</p>
          ) : (
            <ul className="hrd-bars">
              {depts.slice(0, 8).map((d) => (
                <li key={d.id}>
                  <span className="hrd-bar-name" title={d.name}>{d.name}</span>
                  <span className="hrd-bar-track">
                    <span className="hrd-bar-fill" style={{ width: `${(d.member_count / deptMax) * 100}%` }} />
                  </span>
                  <span className="hrd-bar-value">{d.member_count}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/* ------------------------------------- approvals + away + reminders */}
      <div className="hrd-row hrd-row-3">
        <Panel title="Pending approvals" link={{ to: '/approvals', label: 'Open inbox' }}>
          {!approvals.data ? <NA /> : (
            <ul className="hrd-list">
              {approvalRows.map((a) => (
                <li key={a.key}>
                  <Link to="/approvals" className="hrd-list-row">
                    <span className="hrd-list-main">{a.label}</span>
                    <span className={`hrd-count${a.value ? ' is-hot' : ''}`}>{a.value}</span>
                    <IconChevronRight size={14} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Who’s away" note="Today and the next 7 days" link={team ? { to: '/workforce', label: 'Workforce' } : undefined}>
          {!leave.data ? <NA what="Leave is visible to managers and administrators." /> : away.length === 0 ? (
            <p className="hrd-empty">Nobody is on approved leave this week.</p>
          ) : (
            <ul className="hrd-people">
              {away.slice(0, 6).map((a) => {
                const now = a.start_date <= today && a.end_date >= today
                return (
                  <li key={`${a.user_id}-${a.start_date}`}>
                    <Avatar name={a.user_name} small />
                    <span className="hrd-person">
                      <span className="hrd-person-name">{a.user_name}</span>
                      <span className="hrd-person-meta">
                        {a.leave_type_name} · {shortDate(a.start_date)}
                        {a.end_date !== a.start_date && ` – ${shortDate(a.end_date)}`}
                        {a.is_half_day && ' (half day)'}
                      </span>
                    </span>
                    <span className={`hrd-tag${now ? ' is-now' : ''}`}>{now ? 'Today' : 'Upcoming'}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Reminders" note={`Probation in ${probWin} days · documents in ${docWin} days`}
               link={admin ? { to: '/hrms/settings', label: 'Windows' } : undefined}>
          {!probation.data && !documents.data ? <NA what="Reminders are for administrators." /> : (
            <ul className="hrd-people">
              {(probation.data ?? []).slice(0, 4).map((p) => (
                <li key={`p-${p.user_id}`}>
                  <span className="hrd-dot-icon tone-warn" aria-hidden><IconClock size={14} /></span>
                  <span className="hrd-person">
                    <Link to={`/people/${p.user_id}`} className="hrd-person-name">{p.full_name ?? 'Employee'}</Link>
                    <span className="hrd-person-meta">
                      Probation ends {p.probation_end_on ? shortDate(p.probation_end_on) : 'soon'}
                    </span>
                  </span>
                  <span className="hrd-tag">Confirm</span>
                </li>
              ))}
              {(documents.data ?? []).slice(0, 4).map((d) => (
                <li key={`d-${d.id}`}>
                  <span className={`hrd-dot-icon ${d.days_to_expiry !== null && d.days_to_expiry < 0 ? 'tone-bad' : 'tone-idle'}`} aria-hidden>
                    <IconAlert size={14} />
                  </span>
                  <span className="hrd-person">
                    <Link to={`/people/${d.user_id}`} className="hrd-person-name">{d.user_name ?? 'Employee'}</Link>
                    <span className="hrd-person-meta">{d.title ?? d.doc_type} · expires {d.expires_on ? shortDate(d.expires_on) : '—'}</span>
                  </span>
                  <span className={`hrd-tag${d.days_to_expiry !== null && d.days_to_expiry < 0 ? ' is-bad' : ''}`}>
                    {d.days_to_expiry === null ? '—' : d.days_to_expiry < 0 ? 'Expired' : `${d.days_to_expiry}d`}
                  </span>
                </li>
              ))}
              {(probation.data ?? []).length === 0 && (documents.data ?? []).length === 0 && (
                <li className="hrd-empty">Nothing due — no probations ending or documents expiring soon.</li>
              )}
            </ul>
          )}
        </Panel>
      </div>

      {/* ------------------------------------------- onboarding + exits */}
      <div className="hrd-row hrd-row-2">
        <Panel title="Onboarding in progress" link={admin ? { to: '/onboarding', label: 'Onboarding' } : undefined}>
          {!onboarding.data ? <NA what="Onboarding is for administrators." /> : openOnboarding.length === 0 ? (
            <p className="hrd-empty">No joiners being onboarded right now.</p>
          ) : (
            <ul className="hrd-progress">
              {openOnboarding.slice(0, 5).map((o) => {
                const pct = o.total_tasks ? Math.round((o.closed_tasks / o.total_tasks) * 100) : 0
                return (
                  <li key={o.id}>
                    <Avatar name={o.user_name ?? '?'} small />
                    <span className="hrd-person">
                      <span className="hrd-person-name">{o.user_name ?? 'New joiner'}</span>
                      <span className="hrd-person-meta">
                        {o.designation_name ?? 'Joining'} · {shortDate(o.joining_date)}
                        {o.overdue_tasks > 0 && <span className="hrd-late"> · {o.overdue_tasks} overdue</span>}
                      </span>
                    </span>
                    <span className="hrd-meter">
                      <span className="hrd-meter-track"><span style={{ width: `${pct}%` }} /></span>
                      <span className="hrd-meter-text">{o.closed_tasks}/{o.total_tasks}</span>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Exits in progress" link={admin ? { to: '/offboarding', label: 'Offboarding' } : undefined}>
          {!exits.data ? <NA what="Offboarding is for administrators." /> : openExits.length === 0 ? (
            <p className="hrd-empty">Nobody is serving notice.</p>
          ) : (
            <ul className="hrd-progress">
              {openExits.slice(0, 5).map((x) => {
                const pct = x.task_total ? Math.round((x.task_settled / x.task_total) * 100) : 0
                return (
                  <li key={x.id}>
                    <Avatar name={x.user_name ?? '?'} small />
                    <span className="hrd-person">
                      <span className="hrd-person-name">{x.user_name ?? 'Employee'}</span>
                      <span className="hrd-person-meta">
                        Last day {x.last_working_day ? shortDate(x.last_working_day) : 'not set'}
                        {x.blocking_task_count > 0 && <span className="hrd-late"> · {x.blocking_task_count} blocking</span>}
                      </span>
                    </span>
                    <span className="hrd-meter is-exit">
                      <span className="hrd-meter-track"><span style={{ width: `${pct}%` }} /></span>
                      <span className="hrd-meter-text">{x.task_settled}/{x.task_total}</span>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>
      </div>

      {/* --------------------------------- joiners + payroll + helpdesk */}
      <div className="hrd-row hrd-row-wide">
        <Panel title="Recent joiners" link={{ to: '/employees', label: 'All employees' }}>
          {!employees.data ? <NA /> : recent.length === 0 ? (
            <p className="hrd-empty">No joining dates recorded yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="hrd-table">
                <thead>
                  <tr><th>Employee</th><th>Designation</th><th>Department</th><th>Joined</th></tr>
                </thead>
                <tbody>
                  {recent.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <span className="hrd-who">
                          <Avatar name={p.full_name} small />
                          <span className="hrd-person">
                            <Link to={`/people/${p.id}`} className="hrd-person-name">{p.full_name}</Link>
                            <span className="hrd-person-meta">{p.employee_code ?? p.email}</span>
                          </span>
                        </span>
                      </td>
                      <td>{p.designation_name ?? <span className="hrd-muted">—</span>}</td>
                      <td>{p.department_name ?? <span className="hrd-muted">—</span>}</td>
                      <td className="hrd-nowrap">
                        {p.joined_on ? shortDate(p.joined_on) : '—'}
                        {p.joined_on?.startsWith(monthKey) && <span className="hrd-tag is-now">New</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="hrd-stack">
          <Panel title="Payroll" link={admin ? { to: '/payroll', label: 'Pay runs' } : undefined}>
            {!payruns.data ? <NA what="Payroll is for administrators with salary access." /> : !latestRun ? (
              <p className="hrd-empty">No pay run yet.</p>
            ) : (
              <div className="hrd-pay">
                <span className="hrd-pay-period">{MONTHS[latestRun.period_month - 1]} {latestRun.period_year}</span>
                <span className="hrd-pay-net">{money(latestRun.total_net)}</span>
                <span className="hrd-pay-meta">
                  Net pay · {latestRun.employee_count} employees
                </span>
                <span className={`hrd-status is-${latestRun.status}`}>{latestRun.status}</span>
              </div>
            )}
          </Panel>
          <Panel title="Helpdesk" link={team ? { to: '/helpdesk/queue', label: 'Queue' } : undefined}>
            {!openTickets ? <NA what="The queue is for helpdesk staff." /> : (
              <div className="hrd-help">
                <span className="hrd-dot-icon tone-brand" aria-hidden><IconLifebuoy size={16} /></span>
                <span className="hrd-person">
                  <span className="hrd-help-value">{openTickets.length}</span>
                  <span className="hrd-person-meta">
                    open tickets
                    {openTickets.filter((t) => t.priority === 'urgent' || t.priority === 'high').length > 0 &&
                      ` · ${openTickets.filter((t) => t.priority === 'urgent' || t.priority === 'high').length} high priority`}
                  </span>
                </span>
              </div>
            )}
          </Panel>
          <div className="hrd-shortcuts">
            <Link to="/hrms/joiners-letters" className="hrd-shortcut"><IconMail size={15} /> Letters</Link>
            <Link to="/hierarchy" className="hrd-shortcut"><IconBuilding size={15} /> Hierarchy</Link>
            <Link to="/noticeboard" className="hrd-shortcut"><IconSheet size={15} /> Noticeboard</Link>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- pieces --- */

function Panel({
  title, note, link, children,
}: {
  title: string
  note?: string
  link?: { to: string; label: string }
  children: ReactNode
}) {
  return (
    <section className="hrd-panel">
      <header className="hrd-panel-head">
        <div>
          <h2 className="hrd-panel-title">{title}</h2>
          {note && <span className="hrd-panel-note">{note}</span>}
        </div>
        {link && (
          <Link to={link.to} className="hrd-panel-link">
            {link.label} <IconChevronRight size={13} />
          </Link>
        )}
      </header>
      <div className="hrd-panel-body">{children}</div>
    </section>
  )
}

function NA({ what }: { what?: string }) {
  return <p className="hrd-empty hrd-na">Not available{what ? ` — ${what}` : '.'}</p>
}
