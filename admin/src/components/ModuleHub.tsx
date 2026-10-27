import type { ComponentType } from 'react'
import { Link } from 'react-router-dom'
import { IconCard, IconChevronRight, IconStar, IconUsers } from './Icons'

/* The page a module's sidebar heading opens: every screen in the module as a
 * card, each with one line on what it is for. A bare grid of labels made the
 * reader open a page to learn what "Workflow" or "RFQs" meant; the line under
 * the name answers that before the click.
 *
 * All three modules wear the workspace brand colour; the header's name and
 * mark are what tell them apart. */

export type HubModule = 'crm' | 'hrms' | 'erp'

interface HubItem {
  to: string
  label: string
  icon: ComponentType<{ size?: number }>
}

const MODULES: Record<HubModule, { name: string; eyebrow: string; blurb: string; icon: ComponentType<{ size?: number }> }> = {
  crm: {
    name: 'Customer Relationship Management',
    eyebrow: 'CRM',
    blurb: 'Leads, follow-ups, field visits, support and quotations — the whole sales conversation in one place.',
    icon: IconStar,
  },
  hrms: {
    name: 'Human Resources',
    eyebrow: 'HRMS',
    blurb: 'Attendance, payroll, expenses and the people processes that run every working day.',
    icon: IconUsers,
  },
  erp: {
    name: 'Enterprise Resource Planning',
    eyebrow: 'ERP',
    blurb: 'Buying, stock, selling and billing — from requisition to invoice.',
    icon: IconCard,
  },
}

/* One line per screen. Keyed by route, so a renamed menu label keeps its line;
   a screen with no entry here simply shows none. */
const DESCRIPTIONS: Record<string, string> = {
  // CRM
  '/crm': 'Pipeline health, trends and team performance',
  '/crm/leads': 'Capture, qualify and move leads through stages',
  '/crm/follow-ups': 'Calls and meetings due, today and overdue',
  '/crm/visits': 'Plan and log field visits to customers',
  '/crm/support': 'Customer calls, tickets and resolutions',
  '/crm/customers': 'Accounts, contacts and their history',
  '/crm/quotations': 'Build, send and track price quotes',
  '/crm/settings': 'Stages, sources and CRM preferences',
  // HRMS
  '/hrms/dashboard': 'Headcount, joiners, exits and what is due',
  '/attendance': 'Daily punches, presence and regularisation',
  '/hrms/working-hours': 'Hours worked across the team',
  '/salary': 'Salary structure, payslips and pay runs',
  '/expenses': 'Claims, approvals and reimbursements',
  '/settings/approvals': 'Who approves what, level by level',
  '/timesheets': 'Time logged against projects and tasks',
  '/workforce': 'Leave, shifts and team availability',
  '/noticeboard': 'Announcements for the whole company',
  '/me': 'Goals, reviews and feedback',
  '/hrms/joiners-letters': 'Onboarding and HR letters',
  '/hrms/settings': 'Employee IDs, probation and HR defaults',
  // ERP
  '/erp': 'Purchasing, stock and sales at a glance',
  '/erp/approvals': 'Documents waiting on your decision',
  '/erp/requisitions': 'Ask for goods or services to be bought',
  '/erp/rfqs': 'Request and compare vendor quotes',
  '/erp/purchase-orders': 'Orders raised with vendors',
  '/erp/inventory': 'Stock levels, receipts and movements',
  '/erp/sales-orders': 'Customer orders and dispatch',
  '/erp/billing': 'Invoices, receipts and dues',
  '/erp/masters': 'Items, warehouses, vendors and accounts',
  '/erp/settings': 'Numbering, approvals and ERP preferences',
}

export default function ModuleHub({
  module,
  items,
  pathname,
  onPick,
}: {
  module: HubModule
  items: HubItem[]
  pathname: string
  onPick: () => void
}) {
  const meta = MODULES[module]
  const Mark = meta.icon
  return (
    <section className={`hub hub-${module}`} aria-label={`${meta.eyebrow} pages`}>
      <header className="hub-head">
        <span className="hub-mark" aria-hidden><Mark size={22} /></span>
        <div className="hub-head-text">
          <span className="hub-eyebrow">{meta.eyebrow}</span>
          <h1 className="hub-title">{meta.name}</h1>
          <p className="hub-blurb">{meta.blurb}</p>
        </div>
        <span className="hub-count">{items.length} {items.length === 1 ? 'page' : 'pages'}</span>
      </header>

      <div className="hub-grid">
        {items.map((item) => {
          const current = pathname === item.to || pathname.startsWith(`${item.to}/`)
          return (
            <Link
              key={item.to}
              to={item.to}
              className="hub-card"
              aria-current={current ? 'page' : undefined}
              onClick={onPick}
            >
              <span className="hub-card-top">
                <span className="hub-card-icon" aria-hidden><item.icon size={19} /></span>
                {current && <span className="hub-card-here">You are here</span>}
                <span className="hub-card-go" aria-hidden><IconChevronRight size={16} /></span>
              </span>
              <span className="hub-card-label">{item.label}</span>
              {DESCRIPTIONS[item.to] && <span className="hub-card-desc">{DESCRIPTIONS[item.to]}</span>}
            </Link>
          )
        })}
      </div>
    </section>
  )
}
