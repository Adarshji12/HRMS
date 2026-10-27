export type Productivity = 'productive' | 'unproductive' | 'neutral'

export interface TenantInfo {
  id: string
  name: string
  slug: string
  timezone: string
  /**
   * When this company's logo last changed, or null if it has none.
   *
   * Two jobs at once: it is how the console knows to draw the company's mark
   * instead of the product's, and it is what gets hung on the image URL so a
   * replaced logo is actually re-fetched rather than served from cache.
   */
  logo_updated_at: string | null
}

/** `GET /org/company` — the company's identity, as opposed to its settings. */
export interface CompanyProfile {
  id: string
  name: string
  slug: string
  timezone: string
  legal_name: string | null
  industry: string | null
  website: string | null
  contact_email: string | null
  contact_phone: string | null
  address_line1: string | null
  address_line2: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  country: string
  gstin: string | null
  /** Null falls back to the server default — see the Meetings card. */
  meeting_domain: string | null
  /** Derived server-side. The storage key itself never leaves the server. */
  has_logo: boolean
  logo_updated_at: string | null
}

export interface Totals {
  tracked_s: number
  active_s: number
  idle_s: number
  productive_s: number
  unproductive_s: number
  neutral_s: number
  productivity_pct: number
  efficiency_pct: number
}

export interface EmployeeRow extends Totals {
  user_id: string
  full_name: string
  email: string
  team: string | null
  is_online: boolean
  first_activity: string | null
  last_activity: string | null
}

export interface Breakdown {
  label: string
  duration_s: number
  active_s: number
  productivity: Productivity
}

export interface HourBucket {
  hour: number
  active_s: number
  productive_s: number
  unproductive_s: number
}

export interface Dashboard {
  date: string
  timezone: string
  /** What the response covers — the server decides, the console does not guess. */
  scope: 'org' | 'team' | 'self'
  totals: Totals
  online_count: number
  offline_count: number
  working_count: number
  employee_count: number
  screenshot_count: number
  project_count: number
  team_count: number
  employees: EmployeeRow[]
  top_apps: Breakdown[]
  top_domains: Breakdown[]
  browsers: Breakdown[]
  hourly: HourBucket[]
}

export interface Segment {
  id: string
  started_at: string
  ended_at: string
  duration_s: number
  active_s: number
  idle_s: number
  app_name: string
  window_title: string
  is_browser: boolean
  browser: string | null
  url_domain: string | null
  url_full: string | null
  productivity: Productivity
  is_idle: boolean
}

export interface AttendanceRow {
  started_at: string
  ended_at: string | null
  duration_s: number
  end_reason: string | null
}

export interface User {
  id: string
  email: string
  full_name: string
  role: string
  timezone: string
  is_active: boolean
  created_at: string
  notice_accepted_at: string | null
  can_view_screenshots: boolean
  can_approve_timesheets: boolean
  /** Exempt from the geofence, whatever work mode they punch with. */
  can_punch_anywhere: boolean
  /** The named role assigned, if any. Null means their permissions are their own. */
  role_id: string | null
  role_name: string | null
  /** self | team | department | company — resolved from the role, or from their
   *  level when they hold none. */
  data_scope: string
  can_export_data: boolean
  can_manage_projects: boolean
  // HRMS. Optional on the client even though the server now always sends them:
  // a browser holding a page from before the deploy would otherwise read
  // `undefined` as `false` and hide controls the person is entitled to. These
  // flags restrict rather than grant, so absent must mean "not restricted" —
  // read them with `!== false`, never with a bare truthiness check.
  can_approve_leave?: boolean
  can_approve_regularization?: boolean
  can_manage_assets?: boolean
  can_manage_onboarding?: boolean
  can_manage_helpdesk?: boolean
  can_manage_people?: boolean
  can_issue_letters?: boolean
  can_approve_expenses?: boolean
  can_reimburse_expenses?: boolean
  can_approve_loans?: boolean
  can_disburse_loans?: boolean
  /**
   * The one flag above that inverts the rule.
   *
   * Every other flag here restricts something that already existed, so absent
   * means "not restricted" and they are read with `!== false`. Payroll had no
   * prior capability to preserve, and defaulting it on would have handed every
   * administrator every salary the day the migration ran. It defaults **off**,
   * so absent means NOT granted — read this one with `=== true`.
   *
   * The account owner holds it implicitly on the server regardless, which is
   * what stops a workspace locking itself out of its own payroll.
   */
  can_manage_payroll?: boolean
  can_manage_performance?: boolean
  can_manage_engagement?: boolean
  /**
   * Employment lifecycle: pending_setup | active | inactive.
   *
   * Descriptive only. `is_active` is the authentication gate (D-016), and a
   * pre-joiner is neither active nor departed — which is exactly why a boolean
   * could not carry this. Never infer "pre-joiner" from `is_active`.
   */
  status?: string
  hidden_pages: string[]
  /** Per-menu rights from their role, keyed by route; null means every menu.
   *  Served by the API (core/menus.py), which also enforces Add / Edit / Delete. */
  menu_rights?: MenuRights | null
  enrollment_key?: string

  employee_code: string | null
  phone: string | null
  joined_on: string | null

  department_id: string | null
  team_id: string | null
  designation_id: string | null
  schedule_id: string | null
  manager_id: string | null

  /** Resolved server-side so roster tables need no client-side joins. */
  team_name: string | null
  department_name: string | null
  designation_name: string | null
}

export interface Department {
  id: string
  name: string
  code: string | null
  description: string | null
  parent_id: string | null
  head_user_id: string | null
  is_active: boolean
  head_name: string | null
  team_count: number
  member_count: number
}

export interface Team {
  id: string
  name: string
  description: string | null
  department_id: string | null
  manager_user_id: string | null
  is_active: boolean
  department_name: string | null
  manager_name: string | null
  member_count: number
}

export interface Designation {
  id: string
  name: string
  /** 1 is the most senior. */
  level: number
  /** Null when the title is used in any department. */
  department_id: string | null
  department_name: string | null
  is_active: boolean
  member_count: number
}

export interface WorkSchedule {
  id: string
  name: string
  start_time: string
  end_time: string
  working_days: number
  break_minutes: number
  overtime_after_minutes: number
  is_default: boolean
  expected_minutes: number
  member_count: number
}

export interface Project {
  id: string
  name: string
  code: string | null
  description: string | null
  client_name: string | null
  status: 'active' | 'on_hold' | 'completed' | 'archived'
  is_billable: boolean
  /** Paise per hour. Never a float — see the server's plans module. */
  hourly_rate: number
  budget_minutes: number
  start_on: string | null
  end_on: string | null
  manager_user_id: string | null
  department_id: string | null
  color: string | null
  created_at: string
  manager_name: string | null
  member_count: number
  task_count: number
  open_task_count: number
  tracked_seconds: number
  billable_seconds: number
}

export interface ProjectMember {
  id: string
  user_id: string
  full_name: string
  email: string
  role: 'member' | 'lead'
  hourly_rate: number
  tracked_seconds: number
}

export interface Task {
  id: string
  project_id: string
  title: string
  description: string | null
  status: 'todo' | 'in_progress' | 'blocked' | 'done'
  assignee_user_id: string | null
  estimate_minutes: number
  due_on: string | null
  is_billable: boolean | null
  created_at: string
  assignee_name: string | null
  tracked_seconds: number
}

export interface ProjectRule {
  id: string
  project_id: string
  task_id: string | null
  match_type: 'app' | 'domain' | 'title' | 'repo'
  pattern: string
  priority: number
  project_name: string | null
}

export interface ProjectReportRow {
  project_id: string
  name: string
  code: string | null
  client_name: string | null
  status: string
  tracked_s: number
  active_s: number
  billable_s: number
  non_billable_s: number
  budget_minutes: number
  budget_used_pct: number | null
  hourly_rate: number
  billable_amount: number
}

export interface ProjectReport {
  start: string
  end: string
  timezone: string
  projects: ProjectReportRow[]
  totals: { tracked_s: number; billable_s: number; billable_amount: number }
}

export interface HierarchyNode {
  id: string
  name: string
  email: string
  role: string
  designation: string | null
  team: string | null
  department: string | null
  is_active: boolean
  /** Null where the company issues no codes — the chart card simply omits it. */
  employee_code: string | null
  headcount: number
  reports: HierarchyNode[]
}

export interface EmployeeDay {
  date: string
  timezone: string
  employee: User
  totals: Totals
  screenshot_count: number
  attendance: AttendanceRow[]
  top_apps: Breakdown[]
  top_domains: Breakdown[]
  hourly: HourBucket[]
  timeline: Segment[]
}

export interface DailyPoint extends Totals {
  date: string
}

export interface UserSummary extends Totals {
  user_id: string
  full_name: string
  team: string | null
}

export interface TeamSummary {
  team: string
  members: number
  tracked_s: number
  active_s: number
  productive_s: number
  unproductive_s: number
  neutral_s: number
}

export interface ReportSummary {
  start: string
  end: string
  timezone: string
  totals: Totals
  daily: DailyPoint[]
  by_user: UserSummary[]
  by_team: TeamSummary[]
  top_apps: Breakdown[]
  top_domains: Breakdown[]
}

export interface ScreenshotItem {
  id: string
  user_id: string
  captured_at: string
  app_name: string
  window_title: string
  url_domain: string | null
  productivity: Productivity
  activity_pct: number
  monitor_count: number
  blurred: boolean
  width: number
  height: number
  thumb_url: string
  full_url: string
}

export interface Device {
  id: string
  hostname: string
  os: string
  os_version: string
  agent_version: string
  is_active: boolean
  last_seen_at: string | null
  created_at: string
  /** Why this machine captures no screenshots, or null when it does. */
  capture_blocked: string | null
}

export interface OrgSettings {
  screenshot_enabled: boolean
  screenshot_interval_s: number
  screenshot_randomize: boolean
  screenshot_quality: number
  screenshot_max_width: number
  screenshot_retention_days: number
  blur_screenshots: boolean
  capture_all_monitors: boolean
  idle_threshold_s: number
  track_urls: boolean
  track_window_titles: boolean
  activity_retention_days: number
  min_segment_s: number
  sync_interval_s: number
  notice_required: boolean
  notice_text: string
  work_day_start: string
  work_day_end: string
  track_outside_hours: boolean
}

export interface Rule {
  id: string
  match_type: 'app' | 'domain' | 'title'
  pattern: string
  productivity: Productivity
  priority: number
  label: string | null
}

/* --- Core HR --------------------------------------------------------------
 *
 * `pan_masked`, never `pan`. The server masks every statutory value in every
 * list and get; the full number comes only from `POST /people/{id}/reveal/{f}`,
 * which checks a permission and writes an audit row. A `pan: string` here would
 * be a field the server never sends and a habit worth not starting. */

export type ConfirmationStatus =
  | 'not_applicable' | 'probation' | 'confirmed' | 'extended' | 'terminated'

export type EmploymentType =
  | 'full_time' | 'part_time' | 'contract' | 'intern' | 'consultant'

export interface EmployeeProfile {
  user_id: string
  org_id: string

  full_name: string | null
  email: string | null
  employee_code: string | null
  joined_on: string | null
  designation: string | null
  department: string | null
  team: string | null
  manager_name: string | null
  status: string | null

  date_of_birth: string | null
  gender: string | null
  marital_status: string | null
  blood_group: string | null
  nationality: string | null
  father_name?: string | null
  personal_email: string | null
  alternate_phone: string | null

  current_address: string | null
  current_city: string | null
  current_state: string | null
  current_postal_code: string | null
  current_country: string | null

  permanent_address: string | null
  permanent_city: string | null
  permanent_state: string | null
  permanent_postal_code: string | null
  permanent_country: string | null

  emergency_name: string | null
  emergency_relationship: string | null
  emergency_phone: string | null

  pan_masked: string | null
  aadhaar_masked: string | null
  uan: string | null
  pf_number: string | null
  esi_number: string | null
  /** Distinguishes "on file but masked" from "nobody has entered one". */
  has_pan: boolean
  has_aadhaar: boolean
  has_bank_account: boolean

  bank_name: string | null
  bank_branch: string | null
  bank_ifsc: string | null
  bank_account_masked: string | null
  bank_account_name: string | null

  employment_type: string | null
  work_location: string | null
  attendance_type?: string | null
  grade?: string | null
  probation_months: number | null
  /** Days of contractual notice. Null means "not recorded", which an exit
   *  settlement reports as unknown rather than treating as zero — recovering
   *  notice pay against a number nobody set is how a settlement gets disputed. */
  notice_period_days: number | null
  probation_end_on: string | null
  confirmation_status: ConfirmationStatus
  confirmed_on: string | null
  confirmation_note: string | null

  bgv_status: string | null
  bgv_completed_on: string | null
  bgv_agency: string | null
  bgv_note: string | null

  updated_by_name: string | null
  updated_at: string | null

  /** Resolved server-side. The console renders from these rather than
   *  re-deriving the permission rule, because the UI's copy is the one nobody
   *  writes a test for. */
  can_edit_personal: boolean
  can_edit_employment: boolean
  can_reveal: boolean
}

export interface EmployeeDocument {
  id: string
  org_id: string
  user_id: string
  doc_type: string
  title: string | null
  file_name: string | null
  content_type: string | null
  file_size: number
  issued_on: string | null
  expires_on: string | null
  is_verified: boolean
  verified_at: string | null
  note: string | null
  created_at: string
  uploaded_by_name: string | null
  verified_by_name: string | null
  user_name: string | null
  /** Negative means already lapsed. Computed server-side so the list, the tile
   *  and the report all mean the same thing by "expiring soon". */
  days_to_expiry: number | null
}

export interface DirectoryEntry {
  user_id: string
  full_name: string
  email: string
  phone: string | null
  employee_code: string | null
  designation: string | null
  department: string | null
  team: string | null
  manager_name: string | null
  work_location: string | null
  status: string | null
}

/** What `GET /org/modules` returns — which HRMS modules this workspace has. */
export interface ModuleAccess {
  enabled: string[]
  modules: Record<string, { enabled: boolean; in_plan: boolean }>
}

/* --- Letters --------------------------------------------------------------
 *
 * An `IssuedLetter` carries its own `body`. That is not denormalisation to tidy
 * up: the text is frozen at issue, because a letter states facts as they stood
 * on the day it was signed. Re-rendering from the template would silently
 * rewrite a document somebody's bank already holds. */

export type LetterType =
  | 'offer' | 'appointment' | 'confirmation' | 'probation_extension'
  | 'experience' | 'relieving' | 'salary_certificate' | 'address_proof'
  | 'warning' | 'custom'

export type LetterStatus = 'draft' | 'issued' | 'revoked'

export interface MergeField {
  token: string
  label: string
  example: string
  group: string
}

export interface LetterTemplate {
  id: string
  org_id: string
  name: string
  letter_type: LetterType
  description: string | null
  subject: string | null
  body: string
  signatory_name: string | null
  signatory_title: string | null
  employee_requestable: boolean
  is_active: boolean
  created_at: string
  /** Tokens in this body that the server cannot resolve. Empty on anything
   *  saved — the server refuses those — but shown live while editing. */
  unknown_fields: string[]
}

/** What self-service sees: no body, ever. A template body would tell the whole
 *  company what the company puts in its warning letters. */
export interface RequestableTemplate {
  id: string
  name: string
  letter_type: LetterType
  description: string | null
}

export interface LetterPreview {
  text: string
  /** A typo in the template. Refuse to issue on this. */
  unknown: string[]
  /** Registered fields that resolved to nothing. A warning, not an error. */
  empty: string[]
}

export interface IssuedLetter {
  id: string
  org_id: string
  user_id: string
  template_id: string | null
  letter_type: LetterType
  template_name: string | null
  reference_no: string | null
  subject: string | null
  body: string
  signatory_name: string | null
  signatory_title: string | null
  status: LetterStatus
  issued_on: string | null
  revoked_at: string | null
  revoked_reason: string | null
  request_note: string | null
  created_at: string
  user_name: string | null
  issued_by_name: string | null
  revoked_by_name: string | null
  requested_by_name: string | null
  /** Filing into the employee's documents is a side effect that is allowed to
   *  fail, so a screen must be able to say "issued but not filed". */
  is_filed: boolean
}

/* --- Expense claims -------------------------------------------------------
 *
 * Every amount is **integer paise**. `25000` is ₹250.00. No float crosses this
 * boundary in either direction — a rupee amount as a float is a rounding error
 * waiting to become a reimbursement somebody has to chase. Format at the edge
 * with `rupees()` from lib/format; never do arithmetic on the formatted value.
 *
 * There is deliberately no `total_amount` on any request type: the total is
 * summed from the lines server-side, because a total a client sends is a total
 * a client can lie about. */

export type ClaimStatus =
  | 'draft' | 'submitted' | 'approved' | 'rejected' | 'reimbursed' | 'cancelled'

export interface ExpenseCategory {
  id: string
  org_id: string
  name: string
  description: string | null
  requires_receipt: boolean
  /** Paise. null = no ceiling (not 0, which would refuse everything). */
  max_amount: number | null
  is_active: boolean
  /** So the settings screen can explain why a category is not deletable. */
  line_count: number
}

export interface ExpenseLine {
  id: string
  claim_id: string
  category_id: string
  spent_on: string
  description: string
  merchant: string | null
  /** Paise. */
  amount: number
  receipt_name: string | null
  receipt_type: string | null
  receipt_size: number
  created_at: string
  category_name: string | null
  has_receipt: boolean
  /** Whether this line's category demands a receipt — so the gap is visible
   *  before submission is refused. */
  receipt_required: boolean
}

export interface ExpenseClaim {
  id: string
  org_id: string
  user_id: string
  title: string
  note: string | null
  project_id: string | null
  status: ClaimStatus
  /** Paise, summed from the lines. */
  total_amount: number
  currency: string
  /** What was signed off, captured at approval. */
  approved_amount: number | null
  submitted_at: string | null
  reviewed_at: string | null
  review_note: string | null
  reimbursed_at: string | null
  payment_reference: string | null
  created_at: string
  user_name: string | null
  reviewer_name: string | null
  reimbursed_by_name: string | null
  /** Present only when somebody else filed it. */
  created_by_name: string | null
  project_name: string | null
  line_count: number

  /** Resolved server-side. Render from these rather than re-deriving the rule
   *  from a role and three flags — the UI's copy is the one nobody tests. */
  can_edit: boolean
  can_submit: boolean
  can_review: boolean
  can_reimburse: boolean
  can_cancel: boolean
}

export interface ExpenseClaimDetail extends ExpenseClaim {
  lines: ExpenseLine[]
}

export interface ExpenseSummary {
  by_status: Record<string, { count: number; amount: number }>
  /** Approved but not yet paid — what somebody is owed right now. */
  outstanding_amount: number
  outstanding_count: number
  awaiting_review: number
  currency: string
}

/* --- Loans & advances -----------------------------------------------------
 *
 * Amounts are integer paise; `interest_rate_bps` is integer basis points (1200
 * is 12%). Neither ever becomes a float on this side — format with `money()`
 * at the very edge.
 *
 * `outstanding_amount` is **computed per request** from the unpaid instalments;
 * there is no such column. Worth knowing before anyone "caches it for
 * performance" — that is how a balance drifts from its own ledger. */

export type LoanType =
  | 'salary_advance' | 'personal_loan' | 'emergency_loan' | 'travel_advance' | 'other'

export type LoanStatus =
  | 'requested' | 'approved' | 'rejected' | 'active' | 'closed'
  | 'cancelled' | 'written_off'

export type InstalmentStatus = 'pending' | 'paid' | 'waived'

export interface LoanInstalment {
  id: string
  loan_id: string
  /** 1-based, so "3 of 12" reads as 3. */
  sequence: number
  /** The first of the deduction month — a pay cycle, not a day. */
  due_on: string
  amount: number
  status: InstalmentStatus
  /** What actually arrived. Null on a waiver: nothing did. */
  paid_amount: number | null
  paid_on: string | null
  reference: string | null
  note: string | null
  recorded_by_name: string | null
  is_overdue: boolean
}

export interface Loan {
  id: string
  org_id: string
  user_id: string
  loan_type: LoanType
  /** What was asked for. */
  principal: number
  /** What was sanctioned — may be less. Null until approved. */
  approved_principal: number | null
  instalment_count: number
  interest_rate_bps: number
  purpose: string | null
  status: LoanStatus
  requested_on: string
  reviewed_at: string | null
  review_note: string | null
  disbursed_on: string | null
  disbursement_reference: string | null
  closed_on: string | null
  closure_note: string | null
  created_at: string

  user_name: string | null
  reviewer_name: string | null
  disbursed_by_name: string | null
  /** Present only when somebody else filed the request. */
  created_by_name: string | null

  total_repayable: number
  outstanding_amount: number
  /** Excludes waivers — a written-down amount is not money recovered. */
  repaid_amount: number
  instalments_paid: number
  instalments_total: number
  next_due_on: string | null
  currency: string

  can_review: boolean
  can_disburse: boolean
  can_record_repayment: boolean
  can_cancel: boolean
  can_write_off: boolean
}

export interface LoanDetail extends Loan {
  instalments: LoanInstalment[]
}

export interface LoanSummary {
  by_status: Record<string, number>
  outstanding_amount: number
  repaid_amount: number
  active_count: number
  awaiting_decision: number
  currency: string
}

/** One line of what payroll would deduct in a month. */
export interface DeductionRow {
  instalment_id: string
  loan_id: string
  user_id: string
  user_name: string | null
  loan_type: LoanType
  sequence: number
  instalment_count: number
  due_on: string
  amount: number
}

/* --- Payroll: structures --------------------------------------------------
 *
 * Amounts are integer paise and **monthly**. `annual_gross` is derived at the
 * edge as twelve times monthly; there is no annual field on the way in, because
 * two stored figures for one salary is two numbers to disagree.
 *
 * `rate_bps` is integer basis points — 4000 is 40%. */

export type ComponentKind = 'earning' | 'deduction'
export type Calculation =
  | 'fixed' | 'percent_of_basic' | 'percent_of_gross' | 'balance'

export interface PayComponent {
  id: string
  org_id: string
  code: string
  name: string
  kind: ComponentKind
  calculation: Calculation
  rate_bps: number
  /** The component `percent_of_basic` refers to. At most one per company. */
  is_basic: boolean
  /** The entire interface to statutory computation. Nothing downstream infers
   *  these from a component's name. */
  is_pf_wage: boolean
  is_esi_wage: boolean
  is_taxable: boolean
  sort_order: number
  is_active: boolean
  description: string | null
  usage_count: number
}

export interface StructureComponent {
  id: string
  component_id: string
  code: string
  name: string
  kind: ComponentKind
  /** Snapshotted from the catalogue, so this row keeps explaining itself after
   *  the catalogue changes. */
  calculation: Calculation
  rate_bps: number
  amount: number
  is_pf_wage: boolean
  is_esi_wage: boolean
  is_taxable: boolean
  sort_order: number
}

export interface SalaryStructure {
  id: string
  org_id: string
  user_id: string
  effective_from: string
  /** null means this is the revision currently in force. */
  effective_to: string | null
  gross_monthly: number
  reason: string | null
  created_at: string
  user_name: string | null
  created_by_name: string | null
  components: StructureComponent[]
  annual_gross: number
  pf_wage_monthly: number
  esi_wage_monthly: number
  taxable_monthly: number
  is_current: boolean
  currency: string
}

export interface StructurePreview {
  gross_monthly: number
  components: StructureComponent[]
  pf_wage_monthly: number
  esi_wage_monthly: number
  taxable_monthly: number
}

/** An active employee with no salary structure. Carries no amounts, by design. */
export interface UncoveredEmployee {
  user_id: string
  full_name: string
  email: string
  employee_code: string | null
  joined_on: string | null
}

/* --- Payroll: pay runs and payslips ---------------------------------------
 *
 * Amounts are integer paise. **Line amounts are always positive** — `kind`
 * decides the sign. A signed amount means every consumer has to remember which
 * convention it is in, and eventually one does not.
 *
 * `lop_milli_days` is leave's unit: 1000 is one day, 500 a half day. No
 * conversion happens between the two modules. */

export type PayRunStatus = 'draft' | 'computed' | 'approved' | 'paid' | 'cancelled'

export type LineSource =
  | 'structure' | 'loan' | 'expense' | 'manual'
  | 'pf' | 'esi' | 'professional_tax' | 'lwf' | 'tds'

export interface PayslipLine {
  id: string
  /** A third kind arrived with statutory: an employer contribution is neither
   *  paid to the employee nor taken from them, so summing earnings and
   *  deductions ignores it automatically. */
  kind: 'earning' | 'deduction' | 'employer'
  code: string
  name: string
  amount: number
  source: LineSource
  /** Points into whichever table `source` names — a loan instalment, an expense
   *  claim, a pay component. What makes a deduction traceable rather than just
   *  a number. */
  source_id: string | null
  detail: string | null
  sort_order: number
}

export interface Payslip {
  id: string
  org_id: string
  run_id: string
  user_id: string
  structure_id: string | null
  lop_milli_days: number
  month_days: number
  payable_days: number
  /** A full month before any loss of pay, so a payslip reads "₹50,000 less two
   *  days" rather than only the prorated figure. */
  full_gross: number
  gross: number
  total_deductions: number
  net: number
  /** What the company paid on top — employer PF, EPS, ESI, LWF. The other half
   *  of cost to company. */
  employer_contributions: number
  note: string | null
  /** The filed copy in the employee's document record, once the run is frozen
   *  and payslips have been filed. */
  document_id: string | null
  user_name: string | null
  employee_code: string | null
  period_label: string | null
  run_status: string | null
  lines: PayslipLine[]
  currency: string
}

export interface PayRun {
  id: string
  org_id: string
  period_year: number
  period_month: number
  status: PayRunStatus
  pay_date: string | null
  total_gross: number
  total_deductions: number
  total_net: number
  employee_count: number
  computed_at: string | null
  approved_at: string | null
  paid_at: string | null
  payment_reference: string | null
  notes: string | null
  created_at: string
  period_label: string
  computed_by_name: string | null
  approved_by_name: string | null
  paid_by_name: string | null
  currency: string
  can_compute: boolean
  can_approve: boolean
  can_pay: boolean
  can_cancel: boolean
}

export interface PayRunDetail extends PayRun {
  payslips: Payslip[]
  /** Employees left out for want of a salary structure. Skipping is right — a
   *  ₹0 payslip reads as a decision — but silence about it is not. */
  skipped: { user_id: string; full_name: string; reason: string }[]
}

/* --- Payroll: statutory ---------------------------------------------------
 *
 * Rates are integer basis points (1200 = 12%); amounts are integer paise.
 * Neither becomes a float — 12% as `0.12` is the value applied twice. */

export interface StatutoryConfig {
  id: string
  org_id: string

  pf_enabled: boolean
  pf_employee_rate_bps: number
  pf_employer_rate_bps: number
  /** The slice of the employer share going to the pension scheme. An ECR
   *  filing needs it separately. */
  pf_pension_rate_bps: number
  pf_wage_ceiling: number
  pf_cap_at_ceiling: boolean
  /** The pension slice stays capped even when EPF is not — that is how the
   *  scheme works, hence two switches. */
  pf_pension_cap_at_ceiling: boolean

  esi_enabled: boolean
  esi_employee_rate_bps: number
  esi_employer_rate_bps: number
  /** A threshold, not a ceiling: at or above it ESI does not apply at all. */
  esi_wage_threshold: number

  pt_enabled: boolean
  pt_state: string | null

  lwf_enabled: boolean
  lwf_employee_amount: number
  lwf_employer_amount: number
  /** null = every month. Most states collect once or twice a year. */
  lwf_month: number | null

  /* --- Exit settlement ---------------------------------------------------
   * None of this touches a monthly payslip. It is read only when somebody
   * leaves, and it lives here because it is company-wide statutory policy —
   * a settlement screen carrying its own copy of "days in an encashment
   * month" would be a second place for one number to be wrong. */

  /** Off by default: gratuity is due only after five years, and a large
   *  number appearing in a settlement unasked is not a good default. */
  gratuity_enabled: boolean
  /** The Payment of Gratuity Act's own figures — 15 days per completed year,
   *  ÷ 26, capped at ₹20,00,000 (in paise). */
  gratuity_days_per_year: number
  gratuity_month_days: number
  gratuity_ceiling: number
  /** 26 and 30 are both common and differ by 15%. Too big a gap to guess. */
  encashment_month_days: number
  /** True: encash on basic. False: on gross. */
  encashment_on_basic: boolean

  pt_slab_count: number
}

export interface PtSlab {
  id: string
  org_id: string
  min_gross: number
  /** null = the top band. */
  max_gross: number | null
  amount: number
  /** null = every month; a month-specific slab wins over a general one. */
  applies_in_month: number | null
  label: string | null
}

export interface StatutoryPreviewLine {
  code: string
  name: string
  amount: number
  source: string
  detail: string | null
}

export interface StatutoryPreview {
  employee_lines: StatutoryPreviewLine[]
  employer_lines: StatutoryPreviewLine[]
  employee_total: number
  employer_total: number
}

/* --- Payroll: income tax --------------------------------------------------
 *
 * Amounts are integer paise. ₹1,50,000 is `15000000`.
 *
 * `verified_amount` is nullable and the null is load-bearing: it means nobody
 * has checked, which is different from zero, meaning checked and nothing stood
 * up. Read `effective_amount` for what payroll is actually using. */

export type TaxRegime = 'old' | 'new'
export type DeclarationStatus = 'draft' | 'submitted' | 'verified' | 'rejected'
export type TaxItemStatus = 'declared' | 'proof_submitted' | 'verified' | 'rejected'

export interface TaxItem {
  id: string
  declaration_id: string
  section: string
  label: string | null
  declared_amount: number
  verified_amount: number | null
  status: TaxItemStatus
  document_id: string | null
  note: string | null
  /** What payroll is using right now. Computed server-side so this screen and
   *  the pay run cannot disagree. */
  effective_amount: number
  /** The statutory cap, when the section has one. */
  cap: number | null
}

export interface TaxDeclaration {
  id: string
  org_id: string
  user_id: string
  financial_year: number
  regime: TaxRegime
  status: DeclarationStatus
  submitted_at: string | null
  verified_at: string | null
  note: string | null
  created_at: string
  user_name: string | null
  verified_by_name: string | null
  year_label: string
  /** True when the year's slabs were carried forward rather than legislated. */
  provisional: boolean
  items: TaxItem[]
  can_edit: boolean
  can_verify: boolean
}

export interface TaxBreakdown {
  gross_income: number
  standard_deduction: number
  chapter_via: number
  professional_tax: number
  taxable_income: number
  tax_before_rebate: number
  rebate: number
  surcharge: number
  cess: number
  total_tax: number
  regime: TaxRegime
  /** [label, income in the slab, tax on it] — sums to `tax_before_rebate`. */
  slab_working: [string, number, number][]
}

export interface TaxEstimate {
  chosen: TaxRegime
  financial_year: number
  year_label: string
  provisional: boolean
  annual_income: number
  old: TaxBreakdown
  new: TaxBreakdown
}

/* --- Payroll: Form 16 and the year end ------------------------------------
 *
 * `Reconciliation` recomputes on every read from frozen payslips; `Form16` was
 * frozen at issue and never moves. Both carry the same figures on purpose —
 * the difference between them is what a March correction is. */

export interface Reconciliation {
  user_id: string
  user_name: string
  financial_year: number
  year_label: string
  provisional: boolean
  /** Months of approved payroll. Below 12, the balance below reads as
   *  over-deducted because TDS is taken against a full-year projection — that
   *  is expected, not a refund. */
  months_covered: number
  gross_salary: number
  standard_deduction: number
  professional_tax: number
  chapter_via: number
  taxable_income: number
  total_tax: number
  tds_deducted: number
  /** Positive: March still has to take it. Negative: more deducted than the
   *  months covered require. */
  balance: number
  employee_pf: number
  employer_pf: number
  regime: TaxRegime
  age_band: 'below_60' | 'senior' | 'super_senior'
  issued: boolean
  currency: string
}

export interface Form16 {
  id: string
  org_id: string
  user_id: string
  financial_year: number
  /** 1 for the original; a correction is revision 2 with its own reference. */
  revision: number
  reference_no: string
  status: 'issued' | 'revised'
  gross_salary: number
  standard_deduction: number
  professional_tax: number
  chapter_via: number
  taxable_income: number
  tax_before_rebate: number
  rebate: number
  surcharge: number
  cess: number
  total_tax: number
  tds_deducted: number
  balance: number
  employer_pf: number
  employee_pf: number
  regime: TaxRegime
  age_band: string
  months_covered: number
  employee_name: string | null
  /** Masked. The full number appears only on the rendered certificate. */
  employee_pan_masked: string | null
  designation: string | null
  employer_name: string | null
  issued_on: string
  document_id: string | null
  note: string | null
  created_at: string
  currency: string
}

/* --- Payroll: the register ------------------------------------------------
 *
 * Amounts stay in **paise** on the wire, like everywhere else. The CSV export
 * converts to rupees at its own edge, because a spreadsheet is read by a
 * person — two different edges, two deliberate choices. */

export interface RegisterRow {
  user_id: string
  name: string
  employee_code: string | null
  payable_days: number
  month_days: number
  /** Keyed by payslip line code, and sparse — not everybody has every
   *  component, which is why the column order is carried separately. */
  earnings: Record<string, number>
  deductions: Record<string, number>
  employer: Record<string, number>
  gross: number
  total_deductions: number
  net: number
  employer_total: number
}

export interface PayrollRegister {
  run_id: string
  period: string
  status: string
  pay_date: string | null
  earning_codes: string[]
  deduction_codes: string[]
  employer_codes: string[]
  rows: RegisterRow[]
  totals: RegisterRow
  /** Should always be empty. Populated when the totals summed from the payslip
   *  lines disagree with what the run stored — shown rather than hidden. */
  discrepancies: string[]
  currency: string
}

/* --- The unified approvals queue -----------------------------------------
 *
 * `GET /approvals` and `/approvals/counts` aggregate five flows **server-side**.
 * The rich inbox at /approvals keeps fetching each module's own review endpoint,
 * because it shows per-module context — a leave balance, a timesheet's totals —
 * that this flat shape deliberately does not carry. What the flat shape is for
 * is the count: a navigation badge cannot fetch five queues on every page load.
 *
 * One shape for every flow, not a union: a union the caller switched on would
 * put the knowledge of five modules into whatever renders it. */

export interface PendingApproval {
  /** Which flow — 'leave' | 'timesheet' | 'regularization' | 'expense' | 'loan'.
   *  Left as a string: the server owns the list, and a union here would need
   *  editing every time a sixth flow appears. */
  kind: string
  id: string
  user_id: string
  user_name: string
  title: string
  detail: string | null
  /** When it started waiting. */
  since: string
  waiting_days: number
  /** Paise, or **null** where the flow involves no money. Not zero: a leave
   *  request has no amount, and rendering ₹0.00 would read as "free". */
  amount_paise: number | null
  currency: string
}

export interface ApprovalCounts {
  leave: number
  timesheet: number
  regularization: number
  expense: number
  loan: number
  total: number
}

/* --- Performance: appraisals ---------------------------------------------
 *
 * Two integer conventions, both matching the server. `weight_bps` is basis
 * points — 3000 is 30%. `score_centi` is a rating in hundredths — 370 is 3.70.
 * Neither is ever a float on the wire, for the reason every rate and amount in
 * this product is integer: the same figure rendering two different ways in two
 * places is how a performance conversation goes wrong.
 *
 * A rating is meaningless without the scale it was given on, so every review
 * carries one. `rating_max` is the **frozen** scale, set at finalisation;
 * `cycle_rating_max` is the cycle's current one, for a review that has not been
 * finalised yet. */

export interface ReviewCycle {
  id: string
  name: string
  description: string | null
  /** The period being appraised — not the window for doing the appraising. */
  period_start: string
  period_end: string
  self_review_closes: string | null
  manager_review_closes: string | null
  /** 'draft' | 'open' | 'closed'. Closing is one-way. */
  status: string
  rating_max: number
  /** One label per point, lowest first — or null. Never partial. */
  rating_labels: string[] | null
  requires_self_review: boolean
  weights_must_total: boolean
  closed_at: string | null
  created_at: string
  review_count: number
  finalised_count: number
}

export interface Competency {
  id: string
  name: string
  description: string | null
  sort_order: number
  is_active: boolean
}

export interface PerformanceGoal {
  id: string
  title: string
  description: string | null
  target: string | null
  /** Basis points. The set must total 10000 unless the cycle says otherwise. */
  weight_bps: number
  /** Null is **not rated**, which is different from rated lowest. */
  self_rating: number | null
  manager_rating: number | null
  self_comment: string | null
  manager_comment: string | null
  sort_order: number
}

export interface CompetencyRating {
  id: string
  competency_id: string
  /** Copied at rating time. Renaming the competency does not rewrite this. */
  competency_name: string
  self_rating: number | null
  manager_rating: number | null
  comment: string | null
  sort_order: number
}

export interface PerformanceReview {
  id: string
  cycle_id: string
  user_id: string
  manager_id: string | null
  /** 'draft' | 'self_submitted' | 'manager_submitted' | 'returned' | 'finalised' */
  status: string
  self_comment: string | null
  self_submitted_at: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
  overall_rating: number | null
  override_reason: string | null
  final_comment: string | null
  /** Hundredths, frozen at finalisation. Null before it. */
  score_centi: number | null
  /** The scale this was rated on, frozen at finalisation. */
  rating_max: number | null
  finalised_at: string | null
  /** Null means finalised but not yet released to the employee. */
  shared_at: string | null
  created_at: string
  user_name: string | null
  manager_name: string | null
  cycle_name: string | null
  cycle_rating_max: number
  rating_labels: string[] | null
  goals: PerformanceGoal[]
  competencies: CompetencyRating[]
  /** What the score would be right now. Advisory; recomputed on every read. */
  live_score_centi: number | null
  /** False when the reader is the employee and the rating has not been shared.
   *  The rating fields arrive **null** in that case — the server removes them
   *  rather than sending them with a flag. */
  rating_visible: boolean
}

/* --- Engagement: announcements, surveys, recognition ----------------------
 *
 * One thing to know before touching any of this: **a survey response has no
 * identity anywhere in these types, and adding one would be the first step in
 * undoing what the server is built to guarantee.** There is no shape here that
 * pairs an answer with a person, because the server has no column to fill one
 * from.
 *
 * `mean_centi` is a rating in hundredths, matching appraisals. 370 is 3.70. */

export interface AnnouncementPost {
  id: string
  title: string
  body: string
  /** 'draft' | 'published' | 'archived'. Publishing is one-way. */
  status: string
  audience_kind: string
  audience_ids: string[] | null
  is_pinned: boolean
  /** Reading is passive; acknowledging is an act. A policy needs the second. */
  requires_acknowledgement: boolean
  expires_on: string | null
  published_at: string | null
  created_at: string
  published_by_name: string | null
  /** The reader's own. Null on the admin listing, where "read by whom" is the
   *  reach report's question rather than this row's. */
  read_at: string | null
  acknowledged_at: string | null
}

export interface AnnouncementReach {
  audience: number
  read: number
  acknowledged: number
  /** Only the people who have **not** complied — the list that has a use. */
  outstanding: string[]
}

export interface SurveyQuestion {
  id: string
  prompt: string
  /** 'scale' | 'text' | 'choice' */
  kind: string
  scale_max: number
  choices: string[] | null
  is_required: boolean
  sort_order: number
}

export interface PulseSurvey {
  id: string
  title: string
  description: string | null
  /** 'draft' | 'open' | 'closed' */
  status: string
  audience_kind: string
  /** Frozen once the survey opens — the server refuses to flip it after. */
  is_anonymous: boolean
  /** The floor for showing results and any breakdown of them. */
  min_responses: number
  opens_on: string | null
  closes_on: string | null
  closed_at: string | null
  created_at: string
  questions: SurveyQuestion[]
  invited: number
  responded: number
  /** Whether *this* reader has answered. From the participant record, which
   *  knows only that — never what they said. */
  i_responded: boolean
}

export interface SurveyQuestionResult {
  question_id: string
  prompt: string
  kind: string
  /** Hundredths. Null when nothing was rated or the question is not a scale. */
  mean_centi: number | null
  /** Count per scale point, lowest first. */
  distribution: number[]
  texts: string[]
  counts: Record<string, number>
  /** True when this question's answers are withheld for being too few. The
   *  question is still listed — hiding it would make an uncomfortable question
   *  look like one nobody asked. */
  withheld: boolean
}

export interface SurveyResults {
  survey_id: string
  title: string
  is_anonymous: boolean
  invited: number
  responded: number
  min_responses: number
  questions: SurveyQuestionResult[]
  /** Set when the whole survey is below the floor. A refusal, not a warning. */
  withheld_reason: string | null
}

export interface RecognitionPost {
  id: string
  message: string
  competency_id: string | null
  is_public: boolean
  created_at: string
  from_user_id: string | null
  to_user_id: string | null
  /** Null when the person has left — renders as "a former colleague". */
  from_name: string | null
  to_name: string | null
  competency_name: string | null
}

/** One menu's row on a role: Access, plus whichever of add / edit / delete it has. */
export interface MenuRight {
  access: boolean
  add?: boolean
  edit?: boolean
  delete?: boolean
}

export type MenuRights = Record<string, MenuRight>
