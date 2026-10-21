/**
 * The tables that describe an employee's role, permissions and page access.
 *
 * Shared by the add and edit forms. Kept in one place because two copies of
 * "which pages can be hidden" drift: someone adds a page to one list and the
 * other form quietly stops offering it, which nobody notices until an employee
 * can reach something they should not.
 */

export const ROLE_SUMMARY: Record<string, string> = {
  employee:
    'Sees only their own hours, screenshots and timesheets. Cannot see any colleague.',
  manager:
    'Sees the people who report to them, plus any team they manage — their hours, ' +
    'activity and screenshots. Cannot change organisation policy or billing.',
  admin:
    'Sees every employee and changes tracking policy, rules and the org structure. ' +
    'Cannot change billing or the mail connector — those stay with the owner.',
}

/* Each of these is enforced on the server, at the endpoint that does the thing.
   They restrict within a role and can never grant beyond it. */

/* Only pages the server can actually refuse. Employees and Teams & Departments
   are deliberately absent: their endpoints feed the filter dropdowns on
   Reports, Apps and Projects, so hiding them would either break those pages or
   be a nav link that hides nothing. */
export const PAGES = [
  { key: 'activity', label: 'Time & Activity' },
  { key: 'apps', label: 'Apps & Websites' },
  { key: 'timesheets', label: 'Timesheets' },
  { key: 'projects', label: 'Projects' },
  { key: 'reports', label: 'Reports' },
  { key: 'hierarchy', label: 'Hierarchy' },
]

export const PERMISSIONS = [
  /* The seven below were on the server and enforced from day one, but were
     never listed here — so the roles screen offered twelve of the nineteen
     permissions the product actually has, and the other seven could only be
     changed by editing the database. Approving leave was one of them. */
  {
    key: 'can_approve_leave' as const,
    label: 'Approve leave',
    description:
      'Decide leave applications from the people this role can see. Separate ' +
      'from managing the leave policy, which is an administrator’s job.',
  },
  {
    key: 'can_approve_regularization' as const,
    label: 'Approve attendance corrections',
    description:
      'Decide a request to fix a missed or wrong punch. Kept apart from ' +
      'approving leave: one spends a balance, the other corrects a record.',
  },
  {
    key: 'can_manage_assets' as const,
    label: 'Manage the asset register',
    description:
      'Issue, return and retire company kit. Everyone can always see what is ' +
      'assigned to them.',
  },
  {
    key: 'can_manage_onboarding' as const,
    label: 'Run onboarding and offboarding',
    description:
      'The joiner and leaver checklists, their templates, and the exit ' +
      'clearance that gates a final settlement.',
  },
  {
    key: 'can_manage_helpdesk' as const,
    label: 'Work the helpdesk queue',
    description:
      'See and answer tickets raised by others. Raising one needs no ' +
      'permission at all.',
  },
  {
    key: 'can_manage_performance' as const,
    label: 'Run appraisal cycles',
    description:
      'Open and close review cycles and see everybody’s ratings. An ' +
      'employee always has their own review without this.',
  },
  {
    key: 'can_manage_engagement' as const,
    label: 'Publish announcements and surveys',
    description:
      'Post to the noticeboard and run pulse surveys. Reading them, and ' +
      'thanking a colleague, needs nothing.',
  },
  {
    key: 'can_punch_anywhere' as const,
    /**
     * The one permission here that acts on the HOLDER rather than on other
     * people, which is why it stays enabled at every role.
     *
     * The rest govern somebody else's data, so an employee — whose scope is
     * themselves — gains nothing from them and the form greys them out. This
     * one exempts the holder's own punch from the geofence, and the people who
     * need it are field staff and remote hires, who are almost always plain
     * employees. Greying it out for them removed it from its entire audience.
     */
    selfScoped: true,
    label: 'Can punch from anywhere',
    description:
      'Exempt from the geofence, whatever work mode they choose — for field ' +
      'staff, drivers, and permanently remote hires the fence was never meant ' +
      'for. Starts OFF: it removes a control rather than granting one. The ' +
      'punch is still recorded with its coordinates and its distance, so an ' +
      'exempt employee is not an unmeasured one.',
  },
  {
    key: 'can_manage_payroll' as const,
    label: 'See and set salaries',
    description:
      'The narrowest permission here, and the only one that starts OFF. Pay is ' +
      'the figure colleagues compare with each other. The account owner always ' +
      'has it, so a workspace cannot lock itself out of its own payroll.',
  },
  {
    key: 'can_approve_expenses' as const,
    label: 'Approve expense claims',
    description:
      'Sign off that a team member\u2019s spend was legitimate. Distinct from ' +
      'recording it as paid, which is finance\u2019s job, not line management\u2019s.',
  },
  {
    key: 'can_reimburse_expenses' as const,
    label: 'Record expense payments',
    description:
      'Mark an approved claim as paid. Kept apart from approving one so the ' +
      'same person cannot do both.',
  },
  {
    key: 'can_approve_loans' as const,
    label: 'Sanction loans and advances',
    description:
      'Commit the company to lend. Administrators only in practice \u2014 ' +
      'approving a taxi fare is line management, lending money is not.',
  },
  {
    key: 'can_disburse_loans' as const,
    label: 'Disburse loans and record repayments',
    description:
      'Pay out a sanctioned loan and mark instalments received. Separate from ' +
      'sanctioning it, for the same reason as expenses.',
  },
  {
    key: 'can_manage_people' as const,
    label: 'See and edit HR records',
    description:
      'Other people\u2019s master records \u2014 statutory identity, documents, ' +
      'probation. Everyone can always see and edit their own.',
  },
  {
    key: 'can_issue_letters' as const,
    label: 'Issue letters',
    description:
      'Sign an offer, confirmation or experience letter on the company\u2019s ' +
      'behalf. Separate from HR records because a letter is a commitment the ' +
      'company is held to.',
  },
  {
    key: 'can_view_screenshots' as const,
    label: 'View other people\u2019s screenshots',
    description:
      'Off, they still see their own. The most sensitive thing this product ' +
      'records, and often the one a works council asks to limit.',
  },
  {
    key: 'can_approve_timesheets' as const,
    label: 'Approve timesheets',
    description:
      'Signing off the hours payroll is run against. Separate from seeing the ' +
      'team, because reviewing workload and approving pay are not the same job.',
  },
  {
    key: 'can_export_data' as const,
    label: 'Export data',
    description:
      'Download CSVs of other people\u2019s activity, screenshots index and hours. ' +
      'A bulk extract leaves the product and stops being governed by it.',
  },
  {
    key: 'can_manage_projects' as const,
    label: 'Manage projects',
    description:
      'Create and edit projects, members and attribution rules. Off, they can ' +
      'still see projects and log time to them.',
  },
]

/* The ERP's capabilities. Role-only: unlike PERMISSIONS above they are not on
   the per-employee form, because the ERP admits nobody without a named role
   unless they are an administrator (see `services/erp/common.may`). Split into
   pairs on purpose — whoever raises a document is not whoever approves it. */
export const ERP_PERMISSIONS = [
  { key: 'can_manage_erp_masters', label: 'ERP · Maintain items, vendors and warehouses',
    description: 'Create and edit masters, and enter vendor bank details. Approving a vendor is separate.' },
  { key: 'can_verify_vendors', label: 'ERP · Approve vendors and verify bank details',
    description: 'The checker for vendor onboarding and every bank change. Never for a vendor they entered.' },
  { key: 'can_manage_procurement', label: 'ERP · Raise RFQs and purchase orders',
    description: 'Run sourcing and draft orders. Anybody can raise a requisition without this.' },
  { key: 'can_approve_purchases', label: 'ERP · Approve requisitions and purchase orders',
    description: 'When no approval chain is set. Never their own, and waiving late-delivery damages too.' },
  { key: 'can_manage_inventory', label: 'ERP · Receive, issue and move stock',
    description: 'GRNs, issues, returns, transfers, and drafting adjustments.' },
  { key: 'can_approve_stock', label: 'ERP · Approve stock adjustments',
    description: 'A counted variance changes what the company owns, so the counter does not approve it.' },
  { key: 'can_manage_sales_orders', label: 'ERP · Book and dispatch sales orders',
    description: 'Orders from customer POs and quotations, reservations, dispatch and delivery.' },
  { key: 'can_approve_sales_orders', label: 'ERP · Release, hold and close sales orders',
    description: 'Release an order for fulfilment, put it on hold, or short-close it.' },
  { key: 'can_manage_billing', label: 'ERP · Raise invoices and record receipts',
    description: 'Draft and post invoices, record money received, set customer credit terms.' },
  { key: 'can_approve_billing', label: 'ERP · Approve credit notes and credit holds',
    description: 'Credit notes, invoice cancellation, receipt reversal and the customer credit hold.' },
] as const
