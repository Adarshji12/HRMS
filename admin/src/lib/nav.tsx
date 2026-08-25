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
  IconSheet,
  IconSitemap,
  IconUsers,
} from '../components/Icons'

export interface NavItem {
  to: string
  label: string
  icon: (p: { size?: number }) => JSX.Element
  end?: boolean
  sub?: boolean
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
  heading?: string
  items: NavItem[]
}

/* Grouped to match how the work is actually organised: what happened (Time &
   Activity), who it happened to (Employees), and what it was for (Timesheets,
   Projects). Flat lists of nine links stop being scannable at about six.

   This lives outside App.tsx because three surfaces read it now — the rail, the
   breadcrumb, and the command palette's Pages section. A second copy in any of
   them is a link that silently stops existing when someone edits the other. */
export const NAV: NavGroup[] = [
  {
    items: [
      { to: '/', label: 'Dashboard', icon: IconDashboard, end: true },
      { to: '/home', label: 'Home', icon: IconHome, end: true },
      /* `approverOnly`, not `teamOnly`: the inbox holds expense claims and loan
         requests too, and a finance approver is routinely nobody's manager. */
      { to: '/approvals', label: 'Approvals', icon: IconCheck, approverOnly: true },
      { to: '/me', label: 'My performance', icon: IconGauge },
    ],
  },
  {
    heading: 'Time & Activity',
    items: [
      { page: 'activity', to: '/activity', label: 'Time & Activity', icon: IconClock, sub: true },
      { to: '/screenshots', label: 'Screenshots', icon: IconCamera, sub: true },
      { page: 'apps', to: '/apps', label: 'Apps & Websites', icon: IconGlobe, sub: true },
    ],
  },
  {
    heading: 'People',
    items: [
      /* Not teamOnly and not adminOnly: your own master record is yours, and
         the directory returns work contact details only — its shape is what
         makes it safe for everyone, not its audience. */
      { to: '/profile', label: 'My profile', icon: IconUsers, sub: true },
      { to: '/directory', label: 'Directory', icon: IconBuilding, sub: true },
      { to: '/employees', label: 'Employees', icon: IconUsers, sub: true, teamOnly: true },
      /* Self-service first, then the two administration surfaces. `end` on
         /letters so it does not stay lit while the templates child is open. */
      { to: '/my-letters', label: 'My letters', icon: IconMail, sub: true },
      { to: '/letters', label: 'Letters', icon: IconMail, sub: true, adminOnly: true, end: true },
      { to: '/letters/templates', label: 'Letter templates', icon: IconSheet, sub: true, adminOnly: true },
      { to: '/organisation', label: 'Teams & Departments', icon: IconBuilding, sub: true, teamOnly: true },
      /* Not teamOnly: knowing who you report to is the one org question an
         employee genuinely has, and the tree is already scoped. */
      { page: 'hierarchy', to: '/hierarchy', label: 'Hierarchy', icon: IconSitemap, sub: true },
    ],
  },
  /* Attendance and Leave are their own groups rather than rows under Work.
     They are the two surfaces an employee opens most often and the two a
     manager is chased about, so burying them under a heading about projects
     and reports would cost a click on the busiest pages in the product.

     No `page:` keys anywhere in these three groups: PAGE_GUARDS in
     app/api/deps.py has no entry for attendance, leave, assets or helpdesk, and
     a key with no guard behind it hides the link while leaving the data
     reachable — see the note on NavItem.page above. Add the server guard first. */
  {
    heading: 'Attendance',
    items: [
      /* `end` matters: without it the NavLink stays lit on both child routes,
         so "My attendance" and "Team attendance" appear active together. */
      { to: '/attendance', label: 'My attendance', icon: IconClock, sub: true, end: true },
      { to: '/attendance/team', label: 'Team attendance', icon: IconUsers, sub: true, teamOnly: true },
      { to: '/attendance/settings', label: 'Attendance settings', icon: IconGear, sub: true, adminOnly: true },
    ],
  },
  {
    heading: 'Leave',
    items: [
      { to: '/leave', label: 'My leave', icon: IconClock, sub: true, end: true },
      { to: '/leave/team', label: 'Team leave', icon: IconUsers, sub: true, teamOnly: true },
      { to: '/leave/settings', label: 'Leave settings', icon: IconGear, sub: true, adminOnly: true },
    ],
  },
  /* Expenses is its own group rather than a row under Workplace: it has four
     surfaces (mine, approvals, payments, settings) and burying four links under
     a heading about assets and tickets makes none of them findable. */
  {
    heading: 'Expenses',
    items: [
      { to: '/expenses', label: 'My expenses', icon: IconCard, sub: true, end: true },
      { to: '/expenses/review', label: 'Approvals', icon: IconCheck, sub: true, teamOnly: true },
      { to: '/expenses/payments', label: 'Payments', icon: IconCard, sub: true, adminOnly: true },
      { to: '/expenses/settings', label: 'Expense settings', icon: IconGear, sub: true, adminOnly: true },
      /* Loans live in the same group as expenses: both are money owed between
         the company and an employee, and an employee looking for either starts
         from the same place. No manager row — sanctioning a loan is an
         administrator's decision, not line management's. */
      { to: '/loans', label: 'My loans', icon: IconCard, sub: true, end: true },
      { to: '/loans/manage', label: 'Loans & advances', icon: IconCard, sub: true, adminOnly: true },
      { to: '/loans/deductions', label: 'Loan deductions', icon: IconSheet, sub: true, adminOnly: true },
    ],
  },
  /* Payroll is its own group, below Expenses. `adminOnly` on the two
     administration rows is a coarse filter — the real gate is
     `can_manage_payroll` on the server, which an administrator does NOT hold by
     default. An admin without it sees the links and gets a typed 403, which is
     the correct place to learn they need the permission. */
  {
    heading: 'Payroll',
    items: [
      { to: '/salary', label: 'My salary', icon: IconCard, sub: true },
      { to: '/payslips', label: 'My payslips', icon: IconSheet, sub: true },
      { to: '/tax', label: 'Tax declaration', icon: IconSheet, sub: true },
      { to: '/form16', label: 'My Form 16', icon: IconSheet, sub: true },
      { to: '/payroll/runs', label: 'Pay runs', icon: IconClock, sub: true, adminOnly: true },
      { to: '/payroll', label: 'Salary structures', icon: IconSheet, sub: true, adminOnly: true, end: true },
      { to: '/payroll/components', label: 'Pay components', icon: IconGear, sub: true, adminOnly: true },
      { to: '/payroll/statutory', label: 'Statutory settings', icon: IconGear, sub: true, adminOnly: true },
      { to: '/payroll/tax', label: 'Tax declarations', icon: IconCheck, sub: true, adminOnly: true },
      { to: '/payroll/year-end', label: 'Year end & Form 16', icon: IconChart, sub: true, adminOnly: true },
    ],
  },
  {
    heading: 'Workplace',
    items: [
      { to: '/my-assets', label: 'My assets', icon: IconCard, sub: true },
      { to: '/assets', label: 'Assets', icon: IconCard, sub: true, adminOnly: true },
      { to: '/helpdesk', label: 'Helpdesk', icon: IconInfo, sub: true, end: true },
      { to: '/helpdesk/queue', label: 'Ticket queue', icon: IconInfo, sub: true, teamOnly: true },
    ],
  },
  /* No `page:` keys, for the same reason the groups above have none: PAGE_GUARDS
     in app/api/deps.py has no onboarding or offboarding entry, and a key with no
     guard behind it hides the link while leaving the data reachable. */
  {
    heading: 'Joiners & Leavers',
    items: [
      { to: '/my-onboarding', label: 'My onboarding', icon: IconSheet, sub: true },
      { to: '/onboarding', label: 'Onboarding', icon: IconUsers, sub: true, adminOnly: true },
      { to: '/offboarding', label: 'Offboarding', icon: IconReturn, sub: true, adminOnly: true },
    ],
  },
  /* Its own heading rather than a row under Work: an appraisal is not a task,
     and burying "my review" beside "timesheets" is how it goes unnoticed until
     the deadline. */
  {
    heading: 'Noticeboard',
    items: [
      { to: '/noticeboard', label: 'Noticeboard', icon: IconBell, sub: true, end: true },
      { to: '/communication', label: 'Communication', icon: IconMail, sub: true, adminOnly: true },
    ],
  },
  {
    heading: 'Performance',
    items: [
      { to: '/reviews', label: 'My review', icon: IconCheck, sub: true, end: true },
      { to: '/appraisals', label: 'Appraisals', icon: IconGauge, sub: true, teamOnly: true },
    ],
  },
  {
    heading: 'Work',
    items: [
      { page: 'timesheets', to: '/timesheets', label: 'Timesheets', icon: IconSheet, sub: true },
      { page: 'projects', to: '/projects', label: 'Projects', icon: IconFolder, sub: true },
      { page: 'reports', to: '/reports', label: 'Reports', icon: IconChart, sub: true },
    ],
  },
  {
    heading: 'Account',
    items: [
      { to: '/notifications', label: 'Notifications', icon: IconBell, sub: true },
      { to: '/email', label: 'Email setup', icon: IconMail, sub: true, ownerOnly: true },
      { to: '/billing', label: 'Subscription & Billing', icon: IconCard, sub: true, adminOnly: true },
      { to: '/settings', label: 'Settings', icon: IconGear, sub: true, adminOnly: true },
    ],
  },
]

export interface NavAccess {
  isAdmin: boolean
  canViewTeam: boolean
  isOwner: boolean
  /** Page keys this person has been switched out of. */
  hiddenPages: string[]
}

/** Every item the signed-in role can actually reach, flattened. */
export function visibleItems(access: NavAccess): Array<NavItem & { heading?: string }> {
  return NAV.flatMap((group) =>
    group.items
      .filter(
        (item) =>
          (!item.adminOnly || access.isAdmin) &&
          (!item.teamOnly || access.canViewTeam) &&
          (!item.ownerOnly || access.isOwner) &&
          !(item.page && access.hiddenPages.includes(item.page)),
      )
      .map((item) => ({ ...item, heading: group.heading })),
  )
}

/**
 * Which nav entry a URL belongs to.
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
