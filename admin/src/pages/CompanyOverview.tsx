/* Company Overview — the Dashboard module's first tab.
 *
 * One dashboard across the whole product: a headline strip, then HR, the desk
 * monitor, CRM and ERP, each as a band of figures and charts linking on to
 * that module's own dashboard tab. It reads the summary endpoints those
 * dashboards already use; nothing here is a second copy of a calculation.
 *
 * Bands follow the workspace's modules (/org/modules): a company without the
 * ERP does not get an ERP band full of zeros. Every read is soft — one failing
 * call empties its own card, not the page.
 */

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import '../styles/hrdash.css'
import '../styles/company-overview.css'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { todayISO } from '../lib/format'
import type {
  ApprovalCounts, Dashboard as MonitorData, Department, ModuleAccess, User,
} from '../lib/types'
import { ColumnChart, Donut, HourlyChart, RankedBars, type Slice } from '../components/charts'
import { Loading } from '../components/ui'
import { crm, type LeadDashboard } from './crm/api'
import { erp, type Dashboard as ErpData } from './erp/api'
import {
  IconAlert, IconBuilding, IconCard, IconChart, IconCheck, IconChevronRight, IconClock,
  IconDashboard, IconFolder, IconGauge, IconMonitor, IconPlus, IconStar, IconUsers,
} from '../components/Icons'

interface DayRow { status: string; is_late: boolean }

const soft = <T,>(run: () => Promise<T>) => () => run().catch(() => null)

const plusDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const fmt = (n: number | string | null | undefined) =>
  n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN')

/** Decimal-string rupees from the ERP, compact: ₹4.2L, ₹1.3Cr. */
const inr = (v: number | string | null | undefined) => {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n)) return '₹0'
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(1)}Cr`
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(1)}L`
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}

const hours = (s: number) => `${(s / 3600).toFixed(s >= 36000 ? 0 : 1)}h`

type Tone = 'brand' | 'good' | 'warn' | 'bad' | 'idle'
const owed = (v: number | string | null | undefined, tone: Tone): Tone => (Number(v ?? 0) > 0 ? tone : 'idle')

/* ============================================================= the page === */

export default function CompanyOverview() {
  const today = todayISO()
  const from30 = plusDays(today, -30)

  const modules = useQuery('co-modules', soft(() => api.get<ModuleAccess>('/org/modules')))
  const on = (key: string) => (modules.data ? Boolean(modules.data.modules?.[key]?.enabled) : true)

  const employees = useQuery('co-employees', soft(() => api.get<User[]>('/admin/employees')))
  const departments = useQuery('co-departments', soft(() => api.get<Department[]>('/org/departments')))
  const attendance = useQuery(`co-att-${today}`, soft(() =>
    api.get<DayRow[]>(`/attendance/team?start=${today}&end=${today}`)))
  const approvals = useQuery('co-approvals', soft(() => api.get<ApprovalCounts>('/approvals/counts')))
  const monitor = useQuery(`co-monitor-${today}`, soft(() =>
    api.get<MonitorData>(`/admin/dashboard?day=${today}`)), { pollMs: 60_000 })
  // Keyed on the modules read too: fired before it lands, a call would cache
  // a null under the key it keeps afterwards and never be made again.
  const ready = modules.loading ? 'wait' : 'ok'
  const leads = useQuery(`co-crm-${from30}-${ready}`, soft(() =>
    !modules.loading && on('crm') ? crm.dashboard({ date_from: from30, date_to: today }) : Promise.resolve(null)))
  const erpQ = useQuery(`co-erp-${ready}`, soft(() =>
    !modules.loading && on('erp') ? erp.dashboard() : Promise.resolve(null)))

  if (employees.loading && !employees.data) return <Loading label="Building the company overview…" />

  /* ---- HR ---- */
  const people = employees.data ?? []
  const active = people.filter((p) => p.is_active && (p.status ?? 'active') !== 'inactive')
  const headcount = active.length
  const monthKey = today.slice(0, 7)
  const joiners = people.filter((p) => p.joined_on?.startsWith(monthKey)).length
  const rows = attendance.data ?? null
  const present = rows ? rows.filter((r) => r.status === 'present' || r.status === 'half_day') : []
  const late = present.filter((r) => r.is_late).length
  const onLeave = rows ? rows.filter((r) => r.status === 'on_leave').length : 0
  const absent = rows ? rows.filter((r) => r.status === 'absent').length : 0
  const notMarked = Math.max(0, headcount - present.length - onLeave - absent)
  const attSlices: Slice[] = [
    { key: 'present', label: 'Present', value: present.length - late, color: 'var(--status-good)' },
    { key: 'late', label: 'Late', value: late, color: 'var(--status-warn)' },
    { key: 'leave', label: 'On leave', value: onLeave, color: 'var(--series-2, var(--brand))' },
    { key: 'absent', label: 'Absent', value: absent, color: 'var(--status-critical)' },
    { key: 'none', label: 'Not marked', value: notMarked, color: 'var(--neutral-mark, var(--border-strong))' },
  ]
  const depts = [...(departments.data ?? [])].filter((d) => d.is_active).sort((a, b) => b.member_count - a.member_count)
  const deptMax = Math.max(1, ...depts.map((d) => d.member_count))

  /* ---- monitor ---- */
  const m = monitor.data ?? null

  /* ---- CRM ---- */
  const c = leads.data as LeadDashboard | null
  const trend = (c?.trend ?? []).slice(-14).map((p) => ({
    key: p.day,
    label: new Date(`${p.day}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    value: p.new_leads,
  }))
  const funnel = (c?.funnel ?? []).filter((f) => f.count > 0)
  const funnelMax = Math.max(1, ...funnel.map((f) => f.count))

  /* ---- ERP ---- */
  const e = erpQ.data as ErpData | null

  const showCrm = on('crm')
  const showErp = on('erp')

  /* ---- the headline strip: one figure per area ---- */
  const headline: Array<{ label: string; value: ReactNode; hint: string; tone: Tone; to: string; icon: ReactNode }> = [
    { label: 'Employees', value: fmt(headcount), hint: joiners ? `${joiners} joined this month` : 'Active headcount', tone: 'brand', to: '/dashboards/hr', icon: <IconUsers size={16} /> },
    { label: 'Present today', value: rows ? fmt(present.length) : '—', hint: rows ? `${headcount ? Math.round((present.length / headcount) * 100) : 0}% · ${late} late` : 'No attendance data', tone: 'good', to: '/dashboards/hr', icon: <IconCheck size={16} /> },
    { label: 'Online now', value: m ? fmt(m.online_count) : '—', hint: m ? `${m.working_count} working · ${m.employee_count} tracked` : 'Desk monitor', tone: 'brand', to: '/dashboards/monitor', icon: <IconMonitor size={16} /> },
    { label: 'Pending approvals', value: fmt(approvals.data?.total), hint: 'Waiting on a decision', tone: owed(approvals.data?.total, 'bad'), to: '/approvals', icon: <IconClock size={16} /> },
    ...(showCrm ? [{ label: 'New leads · 30d', value: c ? fmt(c.new_leads) : '—', hint: c ? `${c.conversion_rate}% conversion` : 'CRM', tone: 'good' as Tone, to: '/dashboards/crm', icon: <IconStar size={16} /> }] : []),
    ...(showErp ? [{ label: 'Receivables', value: e ? inr(e.billing.outstanding) : '—', hint: e ? `${inr(e.billing.overdue)} overdue` : 'ERP billing', tone: owed(e?.billing.overdue, 'warn'), to: '/dashboards/erp', icon: <IconCard size={16} /> }] : []),
  ]

  return (
    <div className="hrd co">
      {/* ------------------------------------------------------- headline */}
      <div className="hrd-kpis co-headline" role="group" aria-label="Company at a glance"
           style={{ gridTemplateColumns: `repeat(${headline.length}, minmax(150px, 1fr))` }}>
        {headline.map((k) => <Kpi key={k.label} {...k} />)}
      </div>

      {/* ============================================================== HR */}
      <Band icon={<IconUsers size={18} />} tone="brand" title="HR"
            note="Headcount, attendance and the people waiting on you"
            link={{ to: '/dashboards/hr', label: 'HR dashboard' }}>
        <div className="co-kpis">
          <Kpi label="Headcount" value={fmt(headcount)} hint={`${depts.length} departments`} tone="brand" to="/employees" icon={<IconUsers size={16} />} />
          <Kpi label="New joiners" value={fmt(joiners)} hint="This month" tone="good" to="/hrms/joiners-letters" icon={<IconPlus size={16} />} />
          <Kpi label="On leave today" value={rows ? fmt(onLeave) : '—'} hint={rows ? `${absent} absent` : 'No attendance data'} tone={owed(onLeave, 'warn')} to="/dashboards/hr" icon={<IconClock size={16} />} />
          <Kpi label="Leave requests" value={fmt(approvals.data?.leave)} hint={`${fmt(approvals.data?.regularization)} attendance corrections`} tone={owed(approvals.data?.leave, 'warn')} to="/approvals" icon={<IconAlert size={16} />} />
        </div>
        <div className="hrd-row hrd-row-2">
          <Panel title="Today’s attendance" note={rows ? `${present.length + onLeave + absent} of ${headcount} accounted for` : undefined}>
            {!rows ? <NA /> : (
              <div className="hrd-att">
                <Donut slices={attSlices} total={present.length} caption="present" unit="people" size={164} />
                <ul className="hrd-legend">
                  {attSlices.map((s) => (
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
          <Panel title="Headcount by department" note={depts.length ? `Top ${Math.min(depts.length, 7)} of ${depts.length}` : undefined}>
            {!departments.data ? <NA /> : depts.length === 0 ? <p className="hrd-empty">No departments yet.</p> : (
              <ul className="hrd-bars">
                {depts.slice(0, 7).map((d) => (
                  <li key={d.id}>
                    <span className="hrd-bar-name" title={d.name}>{d.name}</span>
                    <span className="hrd-bar-track"><span className="hrd-bar-fill" style={{ width: `${(d.member_count / deptMax) * 100}%` }} /></span>
                    <span className="hrd-bar-value">{d.member_count}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </Band>

      {/* ========================================================= MONITOR */}
      <Band icon={<IconMonitor size={18} />} tone="good" title="Desk monitor"
            note="Who is at their desk today and how the time is going"
            link={{ to: '/dashboards/monitor', label: 'Monitor dashboard' }}>
        <div className="co-kpis">
          <Kpi label="Online now" value={m ? fmt(m.online_count) : '—'} hint={m ? `${m.offline_count} offline` : 'No tracking data'} tone="good" to="/dashboards/monitor" icon={<IconMonitor size={16} />} />
          <Kpi label="Working today" value={m ? fmt(m.working_count) : '—'} hint={m ? `of ${m.employee_count} tracked` : '—'} tone="brand" to="/dashboards/monitor" icon={<IconUsers size={16} />} />
          <Kpi label="Time tracked" value={m ? hours(m.totals.tracked_s) : '—'} hint={m ? `${hours(m.totals.active_s)} active` : '—'} tone="idle" to="/dashboards/monitor" icon={<IconClock size={16} />} />
          <Kpi label="Productivity" value={m ? `${Math.round(m.totals.productivity_pct)}%` : '—'} hint={m ? `${Math.round(m.totals.efficiency_pct)}% efficiency` : '—'} tone={m && m.totals.productivity_pct < 50 ? 'warn' : 'good'} to="/dashboards/monitor" icon={<IconGauge size={16} />} />
        </div>
        <div className="hrd-row co-row-wide">
          <Panel title="Activity through the day" note="Productive and unproductive time by hour">
            {!m ? <NA /> : <HourlyChart data={m.hourly} />}
          </Panel>
          <Panel title="Top applications" note="Today">
            {!m ? <NA /> : <RankedBars items={m.top_apps.slice(0, 6)} emptyLabel="No activity recorded today" />}
          </Panel>
        </div>
      </Band>

      {/* ============================================================= CRM */}
      {showCrm && (
        <Band icon={<IconStar size={18} />} tone="warn" title="CRM"
              note="The last 30 days of the sales pipeline"
              link={{ to: '/dashboards/crm', label: 'CRM dashboard' }}>
          <div className="co-kpis">
            <Kpi label="Total leads" value={c ? fmt(c.total_leads) : '—'} hint={c ? `${fmt(c.total_leads_all_time)} all time` : '—'} tone="brand" to="/crm/leads" icon={<IconUsers size={16} />} />
            <Kpi label="New leads" value={c ? fmt(c.new_leads) : '—'} hint={c ? `${fmt(c.todays_leads)} today` : '—'} tone="good" to="/crm/leads" icon={<IconPlus size={16} />} />
            <Kpi label="Conversion" value={c ? `${c.conversion_rate}%` : '—'} hint={c ? `${fmt(c.converted_leads)} converted · ${fmt(c.lost_leads)} lost` : '—'} tone="brand" to="/dashboards/crm" icon={<IconChart size={16} />} />
            <Kpi label="Follow-ups due" value={c ? fmt(c.follow_ups_due_today) : '—'} hint={c ? `${fmt(c.overdue_follow_ups)} overdue` : '—'} tone={owed(c?.overdue_follow_ups, 'bad')} to="/crm/follow-ups" icon={<IconAlert size={16} />} />
          </div>
          <div className="hrd-row co-row-wide">
            <Panel title="New leads per day" note="Last 14 days">
              {!c ? <NA /> : <ColumnChart data={trend} emptyLabel="No leads in the last 14 days" />}
            </Panel>
            <Panel title="Pipeline by stage">
              {!c ? <NA /> : funnel.length === 0 ? <p className="hrd-empty">No leads in this period.</p> : (
                <ul className="hrd-bars">
                  {funnel.slice(0, 7).map((f) => (
                    <li key={f.status_id ?? f.name}>
                      <span className="hrd-bar-name" title={f.name}>
                        <span className="co-dot" style={{ background: f.colour || 'var(--brand)' }} aria-hidden />{f.name}
                      </span>
                      <span className="hrd-bar-track">
                        <span className="hrd-bar-fill" style={{ width: `${(f.count / funnelMax) * 100}%`, background: f.colour || undefined }} />
                      </span>
                      <span className="hrd-bar-value">{f.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </Band>
      )}

      {/* ============================================================= ERP */}
      {showErp && (
        <Band icon={<IconFolder size={18} />} tone="idle" title="ERP"
              note="Money owed, stock on hand and orders in flight"
              link={{ to: '/dashboards/erp', label: 'ERP dashboard' }}>
          {!e ? <div className="hrd-panel"><div className="hrd-panel-body"><NA what="You may not have an ERP role yet." /></div></div> : (
            <>
              <div className="co-kpis co-kpis-6">
                <Kpi label="Receivables" value={inr(e.billing.outstanding)} hint={`${inr(e.billing.overdue)} overdue`} tone={owed(e.billing.overdue, 'warn')} to="/erp/billing" icon={<IconCard size={16} />} />
                <Kpi label="Billed this month" value={inr(e.billing.billed_this_month)} hint={`${fmt(e.billing.drafts)} drafts`} tone="good" to="/erp/billing" icon={<IconChart size={16} />} />
                <Kpi label="Sales backlog" value={inr(e.sales.backlog_value)} hint={`${fmt(e.sales.orders_open)} open orders`} tone="brand" to="/erp/sales-orders" icon={<IconDashboard size={16} />} />
                <Kpi label="Stock value" value={inr(e.inventory.stock_value)} hint={`${fmt(e.inventory.transfers_in_transit)} transfers in transit`} tone="good" to="/erp/inventory" icon={<IconBuilding size={16} />} />
                <Kpi label="Open POs" value={fmt(e.procurement.pos_open)} hint={`${inr(e.procurement.open_po_value)} · ${fmt(e.procurement.pos_overdue)} late`} tone={owed(e.procurement.pos_overdue, 'warn')} to="/erp/purchase-orders" icon={<IconFolder size={16} />} />
                <Kpi label="Low stock" value={fmt(e.inventory.low_stock)} hint="Below reorder level" tone={owed(e.inventory.low_stock, 'bad')} to="/erp/inventory" icon={<IconAlert size={16} />} />
              </div>
              <div className="hrd-row hrd-row-2">
                <Panel title="Waiting on approval" note="Across procurement, stock and sales">
                  <ul className="hrd-list">
                    {[
                      { label: 'Requisitions', value: e.procurement.requisitions_pending },
                      { label: 'Purchase orders', value: e.procurement.pos_pending },
                      { label: 'Vendors', value: e.procurement.vendors_pending },
                      { label: 'Stock adjustments', value: e.inventory.adjustments_pending },
                      { label: 'Sales orders', value: e.sales.orders_pending },
                      { label: 'Credit notes', value: e.billing.credit_notes_pending },
                    ].map((r) => (
                      <li key={r.label}>
                        <Link to="/erp/approvals" className="hrd-list-row">
                          <span className="hrd-list-main">{r.label}</span>
                          <span className={`hrd-count${Number(r.value) > 0 ? ' is-hot' : ''}`}>{fmt(r.value)}</span>
                          <IconChevronRight size={14} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Panel>
                <Panel title="Low stock items" note="Available below the reorder level">
                  {e.inventory.low_stock_items.length === 0 ? <p className="hrd-empty">Every item is above its reorder level.</p> : (
                    <ul className="hrd-people">
                      {e.inventory.low_stock_items.slice(0, 6).map((it) => (
                        <li key={it.id}>
                          <span className="hrd-dot-icon tone-bad" aria-hidden><IconAlert size={14} /></span>
                          <span className="hrd-person">
                            <span className="hrd-person-name">{it.name}</span>
                            <span className="hrd-person-meta">{it.code} · reorder at {fmt(it.reorder_level)}</span>
                          </span>
                          <span className="hrd-tag is-bad">{fmt(it.available)} left</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              </div>
            </>
          )}
        </Band>
      )}

      <p className="co-foot">Figures refresh when the page opens; the desk monitor every minute.</p>
    </div>
  )
}

/* ------------------------------------------------------------- pieces --- */

function Kpi({ label, value, hint, tone, to, icon }: {
  label: string; value: ReactNode; hint: string; tone: Tone; to: string; icon: ReactNode
}) {
  return (
    <Link to={to} className={`hrd-kpi tone-${tone}`}>
      <span className="hrd-kpi-top">
        <span className="hrd-kpi-label" title={label}>{label}</span>
        <span className="hrd-kpi-icon" aria-hidden>{icon}</span>
      </span>
      <span className="hrd-kpi-value">{value}</span>
      <span className="hrd-kpi-hint" title={hint}>{hint}</span>
    </Link>
  )
}

function Band({ icon, tone, title, note, link, children }: {
  icon: ReactNode; tone: Tone; title: string; note: string
  link: { to: string; label: string }; children: ReactNode
}) {
  return (
    <section className={`co-band tone-${tone}`}>
      <header className="co-band-head">
        <span className="co-band-icon" aria-hidden>{icon}</span>
        <div className="co-band-text">
          <h2 className="co-band-title">{title}</h2>
          <p className="co-band-note">{note}</p>
        </div>
        <Link to={link.to} className="co-band-link">
          {link.label} <IconChevronRight size={14} />
        </Link>
      </header>
      {children}
    </section>
  )
}

function Panel({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="hrd-panel">
      <header className="hrd-panel-head">
        <div>
          <h3 className="hrd-panel-title">{title}</h3>
          {note && <span className="hrd-panel-note">{note}</span>}
        </div>
      </header>
      <div className="hrd-panel-body">{children}</div>
    </section>
  )
}

function NA({ what }: { what?: string }) {
  return <p className="hrd-empty">Not available{what ? ` — ${what}` : '.'}</p>
}
