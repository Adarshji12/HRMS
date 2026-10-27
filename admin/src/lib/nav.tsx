import {
  IconBuilding,
  IconCamera,
  IconCard,
  IconChart,
  IconClock,
  IconDashboard,
  IconFolder,
  IconBell,
  IconGauge,
  IconCheck,
  IconGear,
  IconHome,
  IconInfo,
  IconMail,
  IconReturn,
  IconGlobe,
  IconLifebuoy,
  IconStar,
  IconSheet,
  IconSitemap,
  IconUsers,
} from '../components/Icons'
import type { MenuRights } from './types'

export interface NavItem {
  to: string
  label: string
  icon: (p: { size?: number }) => JSX.Element
  end?: boolean
  /**
   * Sub-heading inside the module's panel. Items with no section sit in an
   * unlabelled block at the top of the rail.
   *
   * Only worth setting where a module has enough surfaces that the split
   * carries information — Payroll's "Mine" against its "Administration", say.
   * A two-item module with two one-item sections is worse than no sections.
   */
  section?: string
  /** Hidden from employees — an administration surface, not self-service. */
  adminOnly?: boolean
  /**
   * Needs a role that can see other people. An employee resolves to a scope of
   * themselves everywhere, so these pages render a list of one, or an org chart
   * they cannot act on — real pages, but not answers to any question they have.
   */
  teamOnly?: boolean
  /**
   * The account holder alone. Stricter than adminOnly: an administrator runs
   * the workspace day to day, but "who may send mail as this company" is the
   * owner's, and it carries a third-party credential.
   */
  ownerOnly?: boolean
  /**
   * Anybody who decides anything — a manager, or somebody holding one of the
   * approval flags without a team. Wider than `teamOnly` on purpose; see
   * `canApproveSomething`.
   */
  approverOnly?: boolean
  /**
   * Key used by the per-employee page deny-list. Only set on pages the server
   * can actually refuse — see PAGE_GUARDS in app/api/deps.py. A key here with
   * no guard behind it would hide the link and leave the data reachable.
   */
  page?: string
}

export interface NavGroup {
  /** Absent on the first group only — the rows that are not a module. */
  heading?: string
  /** Stable identifier for the module. Used to match a route to its panel. */
  key?: string
  /** Shown on the module's sidebar row and in its panel header. */
  icon?: (p: { size?: number }) => JSX.Element
  items: NavItem[]
}

/* One row per module, and the module opens a panel.
 *
 * An administrator can reach about fifty pages. The rail used to list all of
 * them behind collapsible headings, which was better than a flat wall but still
 * meant the rail was a filing cabinet you had to open drawers in. Twelve rows
 * that never scroll beat sixteen that sometimes do, and the drawer contents are
 * better shown in the space where the page will appear than in a 244px column.
 *
 * So: the rail is flat. Four rows that are not modules — Dashboard, Home,
 * Approvals, My performance, the things people come here to click — then one
 * row per module. Clicking a module opens its panel, whose own rail lists the
 * module's pages, grouped by `section`.
 *
 * The FIRST group is special and has no heading: those four are destinations,
 * not modules, and giving them a panel would put a category rail in front of a
 * dashboard.
 *
 * This lives outside App.tsx because four surfaces read it — the rail, the
 * module panels, the breadcrumb, and the command palette's Pages section. A
 * second copy in any of them is a link that silently stops existing when
 * someone edits the other. */
export const NAV: NavGroup[] = [
  {
    items: [
      { to: '/home', label: 'Home', icon: IconHome, end: true },
      /* `approverOnly`, not `teamOnly`: the inbox holds expense claims and loan
         requests too, and a finance approver is routinely nobody's manager. */
      { to: '/approvals', label: 'Approvals', icon: IconCheck, approverOnly: true },
    ],
  },
  /* Dashboard. Overview is the whole company on one page; the tabs after it
     are each module's own full dashboard, opened here so comparing across
     them never leaves this panel. The same pages stay at /hrms/dashboard,
     /crm and /erp inside their own modules. teamOnly throughout: an employee
     resolving to a scope of themselves would read company labels about a
     list of one, and their landing page is Home. */
  {
    heading: 'Dashboard',
    key: 'dashboard',
    icon: IconDashboard,
    items: [
      { to: '/dashboard', label: 'Overview', icon: IconDashboard, end: true, teamOnly: true },
      { to: '/dashboards/hr', label: 'HR', icon: IconUsers, teamOnly: true },
      { to: '/dashboards/crm', label: 'CRM', icon: IconStar, teamOnly: true },
      { to: '/dashboards/erp', label: 'ERP', icon: IconBuilding, teamOnly: true },
      { to: '/dashboards/monitor', label: 'Desk Monitor', icon: IconGauge, teamOnly: true },
    ],
  },
  /* Employee. Formerly "People", and the rename is the point: the module is
     about the person as an employee of this company — their record, their place
     in the org, the letters issued to them — not about people in general.

     Company-wide surfaces lead and personal ones trail, which is the reverse of
     how this module used to read. It was written for an employee opening their
     own profile; it is opened far more often by somebody looking up a colleague
     or an org line, and "My profile" is one click from the account menu anyway. */
  {
    heading: 'Employee',
    key: 'people',
    icon: IconUsers,
    items: [
      { to: '/employees', label: 'Employee', icon: IconUsers, teamOnly: true },
      /* Its own path inside this module, not /settings/roles: that route lives
         under the Settings panel, so the tab would throw you out of Employee. */
      { to: '/roles', label: 'Role & Permission', icon: IconGear, adminOnly: true },
      /* Not teamOnly: knowing who you report to is the one org question an
         employee genuinely has, and the tree is already scoped. */
      { page: 'hierarchy', to: '/hierarchy', label: 'Hierarchy', icon: IconSitemap },
      /* Departments and designations live under Settings → Teams & Departments
         only; they are company setup, not something looked up per employee. */
    ],
  },
  /* Workforce Management. Attendance and Leave were two modules and are now one,
     because they are two halves of a single question — who is expected in, and
     who is not — and answering it meant opening two rails. The merge is what
     makes the Overview page possible at all: leave taken, attendance against
     shift, and who is away this week are one reading, and they had no module to
     live in while the two were separate.

     No `page:` keys in here: PAGE_GUARDS in app/api/deps.py has no entry for
     attendance, and a key with no guard behind it hides the link while leaving
     the data reachable — see the note on NavItem.page above. `leave` HAS a
     guard, so the leave rows carry it and the attendance rows do not. */
  {
    heading: 'Workforce Management',
    key: 'workforce',
    icon: IconClock,
    items: [
      /* teamOnly, unlike everything below it: the overview reads leave across
         other people, and for an employee it would resolve to a chart of
         themselves — a page that answers a question they did not ask. */
      { page: 'leave', to: '/workforce', label: 'Overview', icon: IconGauge, teamOnly: true, end: true },
      /* `end` matters on both "mine" rows: without it the NavLink stays lit on
         the team child too, so both rows appear active at once. */
      { to: '/attendance', label: 'My attendance', icon: IconClock, section: 'Attendance', end: true },
      { to: '/attendance/team', label: 'Team attendance', icon: IconUsers, section: 'Attendance', teamOnly: true },
      { page: 'leave', to: '/leave', label: 'My leave', icon: IconReturn, section: 'Leave', end: true },
      { page: 'leave', to: '/leave/team', label: 'Team leave', icon: IconUsers, section: 'Leave', teamOnly: true },
    ],
  },
  /* `adminOnly` on the administration rows is a coarse filter — the real gate
     is `can_manage_payroll` on the server, which an administrator does NOT hold
     by default. An admin without it sees the links and gets a typed 403, which
     is the correct place to learn they need the permission. */
  {
    heading: 'Payroll',
    key: 'payroll',
    icon: IconSheet,
    items: [
      { to: '/salary', label: 'My salary', icon: IconCard, section: 'Mine' },
      { to: '/payslips', label: 'My payslips', icon: IconSheet, section: 'Mine' },
      { to: '/tax', label: 'Tax declaration', icon: IconSheet, section: 'Mine' },
      { to: '/form16', label: 'My Form 16', icon: IconSheet, section: 'Mine' },
      /* The module's front door, and first because it answers the question
         somebody arrives with — where is this month, what does it cost, what is
         waiting on me. Payroll had eight screens and no landing page, so
         opening it dropped people on the salary-structure register: a reference
         table, not an answer. */
      { to: '/payroll/overview', label: 'Overview', icon: IconGauge, section: 'Administration', adminOnly: true },
      { to: '/payroll/runs', label: 'Pay runs', icon: IconClock, section: 'Administration', adminOnly: true },
      { to: '/payroll', label: 'Salary structures', icon: IconSheet, section: 'Administration', adminOnly: true, end: true },
      { to: '/payroll/components', label: 'Pay components', icon: IconGear, section: 'Administration', adminOnly: true },
      { to: '/payroll/tax', label: 'Tax declarations', icon: IconCheck, section: 'Administration', adminOnly: true },
      { to: '/payroll/year-end', label: 'Year end & Form 16', icon: IconChart, section: 'Administration', adminOnly: true },
    ],
  },
  /* Loans share the module with expenses: both are money owed between the
     company and an employee, and somebody looking for either starts from the
     same place. No manager row on loans — sanctioning one is an
     administrator's decision, not line management's. */
  {
    heading: 'Expenses',
    key: 'money',
    icon: IconCard,
    items: [
      { to: '/expenses', label: 'My expenses', icon: IconCard, section: 'Expenses', end: true },
      { to: '/expenses/review', label: 'Approvals', icon: IconCheck, section: 'Expenses', teamOnly: true },
      { to: '/expenses/payments', label: 'Payments', icon: IconCard, section: 'Expenses', adminOnly: true },
      { to: '/loans', label: 'My loans', icon: IconCard, section: 'Loans', end: true },
      { to: '/loans/manage', label: 'Loans & advances', icon: IconCard, section: 'Loans', adminOnly: true },
      { to: '/loans/deductions', label: 'Loan deductions', icon: IconSheet, section: 'Loans', adminOnly: true },
    ],
  },
  /* Workflow, lifted out of Settings. It was "Approval workflow", one row among
     eleven configuration pages, which is where it went unnoticed: it is not a
     setting on a module, it is the rule every module's approvals run through,
     and a chain nobody knows exists is a chain nobody maintains. */
  {
    heading: 'Workflow',
    key: 'workflow',
    icon: IconSitemap,
    items: [
      { to: '/settings/approvals', label: 'Approval chains', icon: IconSitemap, adminOnly: true },
    ],
  },
  /* Desk Monitor, formerly "Time & Work". The old name described the module by
     what it contained; this one describes what it does, which is the part
     people needed to know before clicking. Timesheets, activity, apps,
     screenshots and the reports drawn from them all come off one thing — what
     the desktop agent observed — and the name now says so. */
  {
    heading: 'Desk Monitor',
    key: 'time',
    icon: IconGauge,
    items: [
      { page: 'timesheets', to: '/timesheets', label: 'Timesheets', icon: IconSheet },
      { page: 'activity', to: '/activity', label: 'Time & Activity', icon: IconClock },
      { page: 'apps', to: '/apps', label: 'Apps & Websites', icon: IconGlobe },
      { to: '/screenshots', label: 'Screenshots', icon: IconCamera },
      { page: 'projects', to: '/projects', label: 'Projects', icon: IconFolder },
      { page: 'reports', to: '/reports', label: 'Reports', icon: IconChart },
    ],
  },
  /* Asset Management and Helpdesk were one module called "Workplace", which is
     a category rather than a thing anybody looks for. Split, because they are
     two unrelated errands: what the company lent you, and who to ask when
     something is wrong. */
  {
    heading: 'Asset Management',
    key: 'assets',
    icon: IconCard,
    items: [
      { to: '/assets/dashboard', label: 'Dashboard', icon: IconDashboard, adminOnly: true },
      { to: '/assets', label: 'All assets', icon: IconBuilding, adminOnly: true, end: true },
      { to: '/assets/renewals', label: 'Renewals', icon: IconClock, adminOnly: true },
      { to: '/assets/report', label: 'Assignment report', icon: IconChart, adminOnly: true },
      { to: '/my-assets', label: 'My assets', icon: IconCard, end: true },
    ],
  },
  {
    heading: 'Helpdesk',
    key: 'helpdesk',
    icon: IconInfo,
    items: [
      { to: '/helpdesk', label: 'Helpdesk', icon: IconInfo, end: true },
      { to: '/helpdesk/queue', label: 'Ticket queue', icon: IconInfo, teamOnly: true },
    ],
  },
  /* No `page:` keys, for the same reason the modules above have none:
     PAGE_GUARDS has no onboarding or offboarding entry, and a key with no guard
     behind it hides the link while leaving the data reachable. */
  {
    heading: 'Joiners & Leavers',
    key: 'lifecycle',
    icon: IconSitemap,
    items: [
      { to: '/my-onboarding', label: 'My onboarding', icon: IconSheet },
      { to: '/onboarding', label: 'Onboarding', icon: IconUsers, adminOnly: true },
      { to: '/offboarding', label: 'Offboarding', icon: IconReturn, adminOnly: true },
    ],
  },
  {
    heading: 'Noticeboard',
    key: 'noticeboard',
    icon: IconBell,
    items: [
      { to: '/noticeboard', label: 'Noticeboard', icon: IconBell, end: true },
      { to: '/communication', label: 'Communication', icon: IconMail, adminOnly: true },
    ],
  },
  /* Its own module rather than a row under Desk Monitor: an appraisal is not a
     task, and burying "my review" beside "timesheets" is how it goes unnoticed
     until the deadline. */
  {
    heading: 'Performance',
    key: 'performance',
    icon: IconGauge,
    items: [
      { to: '/me', label: 'My performance', icon: IconGauge },
      { to: '/reviews', label: 'My review', icon: IconCheck, end: true },
      { to: '/appraisals', label: 'Appraisals', icon: IconGauge, teamOnly: true },
    ],
  },
  /* CRM. The only module in this rail that faces outward — everything above it
     is about the people who work here, this one is about the people who buy.
     It carries its own Settings row rather than joining the Settings module
     below: a lead status is not a workspace preference, it is the shape of the
     pipeline, and somebody editing it is inside the CRM at the time.

     No `adminOnly` on the working pages and no `teamOnly` either. Scope is
     resolved on the server — a salesperson opening My Leads sees their own, a
     manager sees their team's — so hiding the row from an employee would take
     away the page they use most. Settings IS adminOnly, and the server refuses
     it too. */
  {
    heading: 'CRM',
    key: 'crm',
    icon: IconStar,
    items: [
      { to: '/crm', label: 'Lead Dashboard', icon: IconDashboard, end: true },
      { to: '/crm/leads', label: 'My Leads', icon: IconUsers },
      { to: '/crm/follow-ups', label: 'My Follow-ups', icon: IconClock },
      { to: '/crm/visits', label: 'My Visit', icon: IconGlobe },
      { to: '/crm/support', label: 'My Support Desk', icon: IconLifebuoy },
      { to: '/crm/customers', label: 'My Customers', icon: IconBuilding },
      /* `end` so the row does not stay lit while the builder is open on a
         child route — the builder is its own place, not the list. */
      { to: '/crm/quotations', label: 'Quatation', icon: IconSheet, end: true },
      { to: '/crm/settings', label: 'Setting', icon: IconGear, adminOnly: true },
    ],
  },
  /* Configuration, gathered out of eight other modules. `Workspace` describes
     the company; `Modules` is one entry per module, named for the module —
     "Attendance", not "Attendance settings", because the panel header already
     supplies the noun.

     Approval workflow has left for its own module and is deliberately not
     duplicated here: two doors to one page means two places to notice it has
     been renamed. */
  {
    heading: 'Settings',
    key: 'settings',
    icon: IconGear,
    items: [
      /* First in Workspace, and not adminOnly: the company's own name and
         address are on every employee's payslip already, so the page is
         readable by everyone and the *form* is what an administrator gets.
         Gating the link would hide a page people are allowed to open. */
      { to: '/settings/company', label: 'Company profile', icon: IconBuilding, section: 'Workspace' },
      { to: '/settings/roles', label: 'Roles & Permissions', icon: IconUsers, section: 'Workspace', adminOnly: true },
      { to: '/settings/organisation', label: 'Teams & Departments', icon: IconBuilding, section: 'Workspace', teamOnly: true },
      { to: '/settings/notifications', label: 'Notifications', icon: IconBell, section: 'Workspace' },
      { to: '/settings/email', label: 'Email setup', icon: IconMail, section: 'Workspace', ownerOnly: true },
      { to: '/billing', label: 'Subscription & Billing', icon: IconCard, section: 'Workspace', adminOnly: true },
      { to: '/settings/tracking', label: 'Desk Monitor', icon: IconGauge, section: 'Modules', adminOnly: true },
      { to: '/settings/attendance', label: 'Attendance', icon: IconClock, section: 'Modules', adminOnly: true },
      { to: '/settings/leave', label: 'Leave', icon: IconReturn, section: 'Modules', adminOnly: true },
      { to: '/settings/expenses', label: 'Expenses', icon: IconCard, section: 'Modules', adminOnly: true },
      { to: '/settings/payroll', label: 'Payroll', icon: IconSheet, section: 'Modules', adminOnly: true },
    ],
  },
]

export const HRMS_NAV_ITEMS: NavItem[] = [
  { to: '/hrms/dashboard', label: 'HR Dashboard', icon: IconDashboard, end: true },
  { to: '/attendance', label: 'Attandance', icon: IconClock, end: true },
  { to: '/hrms/working-hours', label: 'Working Hours', icon: IconGauge, teamOnly: true },
  { to: '/salary', label: 'Payroll', icon: IconSheet, end: true },
  { to: '/expenses', label: 'Expense', icon: IconCard, end: true },
  { to: '/settings/approvals', label: 'Workflow', icon: IconSitemap, end: true, adminOnly: true },
  { page: 'timesheets', to: '/timesheets', label: 'Timesheet', icon: IconSheet },
  { to: '/workforce', label: 'Workforce Management', icon: IconUsers, end: true, teamOnly: true },
  { to: '/noticeboard', label: 'Noticeboard', icon: IconBell, end: true },
  { to: '/me', label: 'Performance', icon: IconStar, end: true },
  { to: '/hrms/joiners-letters', label: 'Joiners & Letters', icon: IconMail, end: true },
  { to: '/hrms/settings', label: 'HR Settings', icon: IconGear, end: true },
]

/* ERP phase one — the operational backbone of the LRS PRD. Every page reads
   its own permissions from /erp/access, so nothing here is adminOnly except
   Settings: an employee opens Requisitions to ask for something, and the other
   pages tell somebody without an ERP role that they have none. */
export const ERP_NAV_ITEMS: NavItem[] = [
  { to: '/erp', label: 'ERP Dashboard', icon: IconDashboard, end: true },
  { to: '/erp/approvals', label: 'ERP Approvals', icon: IconCheck, end: true },
  { to: '/erp/requisitions', label: 'Requisitions', icon: IconSheet, end: true },
  { to: '/erp/rfqs', label: 'RFQs', icon: IconMail, end: true },
  { to: '/erp/purchase-orders', label: 'Purchase Orders', icon: IconCard, end: true },
  { to: '/erp/inventory', label: 'Inventory', icon: IconFolder, end: true },
  { to: '/erp/sales-orders', label: 'Sales Orders', icon: IconChart, end: true },
  { to: '/erp/billing', label: 'Billing', icon: IconCard, end: true },
  { to: '/erp/masters', label: 'Masters', icon: IconBuilding, end: true },
  { to: '/erp/settings', label: 'Setting', icon: IconGear, end: true, adminOnly: true },
]

export interface NavAccess {
  isAdmin: boolean
  canViewTeam: boolean
  isOwner: boolean
  /** Whether they decide anything — wider than `canViewTeam`, because a finance
   *  approver is routinely nobody's manager. See `canApproveSomething`. */
  canApprove: boolean
  /** Page keys this person has been switched out of. */
  hiddenPages: string[]
  /** Per-menu rights from their role; null or absent means every menu. */
  menuRights?: MenuRights | null
}

/** Whether a menu's own route is open to this person. A route the role's
 *  rights do not name is not a menu of its own, so it is left alone. */
export function menuOpen(to: string, rights: MenuRights | null | undefined): boolean {
  if (!rights) return true
  const row = rights[to]
  return row === undefined ? true : row.access
}

/** Whether a page may be opened, by the menu that owns it: the longest menu
 *  route the path sits under. `/crm/leads/42` is My Leads' page, not CRM's. */
export function routeOpen(pathname: string, rights: MenuRights | null | undefined): boolean {
  if (!rights) return true
  let best: string | null = null
  for (const key of Object.keys(rights)) {
    const hit = key === '/' ? pathname === '/' : pathname === key || pathname.startsWith(`${key}/`)
    if (hit && (best === null || key.length > best.length)) best = key
  }
  return best === null || rights[best].access
}

/** Whether this person may open a single entry. */
export function canSee(item: NavItem, access: NavAccess): boolean {
  return (
    (!item.adminOnly || access.isAdmin) &&
    (!item.teamOnly || access.canViewTeam) &&
    (!item.approverOnly || access.canApprove) &&
    (!item.ownerOnly || access.isOwner) &&
    !(item.page && access.hiddenPages.includes(item.page)) &&
    menuOpen(item.to, access.menuRights)
  )
}

/** The entries of one module this person may open, in declared order. */
export function itemsIn(group: NavGroup, access: NavAccess): NavItem[] {
  return group.items.filter((item) => canSee(item, access))
}

/**
 * A module's entries, split into the sections its panel renders.
 *
 * Order follows first appearance in `items` rather than a sort, so the panel
 * reads in the order the module was written — "Mine" before "Administration"
 * because that is how the payroll module is declared, not because M sorts
 * before A.
 */
export function sectionsIn(
  group: NavGroup,
  access: NavAccess,
): Array<{ heading?: string; items: NavItem[] }> {
  const order: Array<string | undefined> = []
  const bySection = new Map<string | undefined, NavItem[]>()
  for (const item of itemsIn(group, access)) {
    if (!bySection.has(item.section)) {
      bySection.set(item.section, [])
      order.push(item.section)
    }
    bySection.get(item.section)!.push(item)
  }
  return order.map((heading) => ({ heading, items: bySection.get(heading)! }))
}

/** Every item the signed-in role can actually reach, flattened. */
export function visibleItems(access: NavAccess): Array<NavItem & { heading?: string }> {
  return NAV.flatMap((group) =>
    itemsIn(group, access).map((item) => ({ ...item, heading: group.heading })),
  )
}

/** The modules this person can open at all, with at least one reachable page. */
export function visibleModules(access: NavAccess): NavGroup[] {
  return NAV.filter((group) => group.heading && itemsIn(group, access).length > 0)
}

/** The rows that are not modules — Dashboard, Home, Approvals, My performance. */
export function topLevelItems(access: NavAccess): NavItem[] {
  const first = NAV.find((group) => !group.heading)
  return first ? itemsIn(first, access) : []
}

/**
 * Where a module's sidebar row points.
 *
 * The first page the reader can actually open, not a fixed one: an employee
 * holds none of Payroll's administration pages, so a row hard-wired to
 * `/payroll/runs` would be a link into a permission bounce.
 */
export function firstRouteIn(group: NavGroup, access: NavAccess): string | undefined {
  return itemsIn(group, access)[0]?.to
}

/**
 * Which entry a URL belongs to.
 *
 * Longest matching prefix, not first match: `/employees/:id` and `/projects/:id`
 * are detail pages with no nav entry of their own, and they belong under the
 * list they were opened from. `/` would prefix-match everything, so it only
 * counts on an exact hit.
 */
export function locate(
  pathname: string,
  access: NavAccess,
): { item: NavItem; heading?: string } | null {
  let best: { item: NavItem; heading?: string } | null = null
  for (const entry of visibleItems(access)) {
    const hit =
      entry.to === '/'
        ? pathname === '/'
        : pathname === entry.to || pathname.startsWith(`${entry.to}/`)
    if (!hit) continue
    if (!best || entry.to.length > best.item.to.length) best = { item: entry, heading: entry.heading }
  }
  return best
}

/**
 * Which module a URL sits in, so the sidebar row can light up.
 *
 * A module row links to its first page, so a plain NavLink would only be
 * active on that one page — open My payslips and the Payroll row would go
 * dark. Matching on the module instead keeps the row lit across every page
 * inside it, which is what a reader expects of a row that names the module.
 */
export function moduleOf(pathname: string, access: NavAccess): NavGroup | null {
  const here = locate(pathname, access)
  if (!here) return null
  return NAV.find((group) => group.heading === here.heading && group.heading) ?? null
}
