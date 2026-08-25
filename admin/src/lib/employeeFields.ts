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
