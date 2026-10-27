/**
 * The Add Employee form's model: one draft, the rules it is checked against,
 * and the list of calls that turn it into a person.
 *
 * Hiring somebody touches six modules — the account, core HR, attendance,
 * payroll, assets and documents — and each already has its own endpoint with
 * its own permission check. The form does not invent a seventh endpoint that
 * would duplicate all of those rules; it creates the account first and then
 * applies each section through the endpoint that owns it. A section that fails
 * is reported and retried on its own, so a rejected IFSC never costs HR the
 * account they just created.
 */
import { PERMISSIONS } from '../../../../lib/employeeFields'
import { toPaise } from '../../../../lib/format'
import type { EmployeeProfile, User } from '../../../../lib/types'

type PermissionKey = (typeof PERMISSIONS)[number]['key']

export interface DocumentDraft {
  key: string
  doc_type: string
  title: string
  issued_on: string
  expires_on: string
  file: File | null
}

export interface HireDraft {
  // --- basic
  first_name: string
  middle_name: string
  last_name: string
  email: string
  phone: string
  employee_code: string
  joined_on: string
  status: 'active' | 'pending_setup' | 'inactive'
  timezone: string
  /** May the account sign in. Only offered when editing. */
  is_active: boolean

  // --- personal
  date_of_birth: string
  gender: string
  marital_status: string
  blood_group: string
  nationality: string
  father_name: string
  personal_email: string
  alternate_phone: string
  emergency_name: string
  emergency_relationship: string
  emergency_phone: string

  // --- address
  current_address: string
  current_city: string
  current_state: string
  current_postal_code: string
  current_country: string
  permanent_same: boolean
  permanent_address: string
  permanent_city: string
  permanent_state: string
  permanent_postal_code: string
  permanent_country: string

  // --- job
  department_id: string
  designation_id: string
  team_id: string
  manager_id: string
  employment_type: string
  work_location: string
  grade: string
  probation_months: string
  notice_period_days: string
  bgv_status: string

  // --- attendance
  attendance_type: string
  shift_id: string
  schedule_id: string
  can_punch_anywhere: boolean

  // --- pay
  gross_monthly: string
  salary_from: string
  salary_components: string[]
  fixed_amounts: Record<string, string>
  pan: string
  aadhaar: string
  uan: string
  pf_number: string
  esi_number: string
  bank_name: string
  bank_branch: string
  bank_ifsc: string
  bank_account: string
  bank_account_confirm: string
  bank_account_name: string

  // --- assets
  asset_ids: string[]
  asset_note: string

  // --- documents
  documents: DocumentDraft[]

  // --- access
  role_id: string
  role: string
  console_access: boolean
  password: string
  permissions: Record<PermissionKey, boolean>
  hidden_pages: string[]

  // --- review
  start_onboarding: boolean
  onboarding_template_id: string
}

const today = () => new Date().toISOString().slice(0, 10)

export function emptyDraft(): HireDraft {
  return {
    first_name: '', middle_name: '', last_name: '', email: '', phone: '',
    employee_code: '', joined_on: today(), status: 'active', is_active: true,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',

    date_of_birth: '', gender: '', marital_status: '', blood_group: '',
    nationality: 'Indian', father_name: '', personal_email: '', alternate_phone: '',
    emergency_name: '', emergency_relationship: '', emergency_phone: '',

    current_address: '', current_city: '', current_state: '', current_postal_code: '',
    current_country: 'IN', permanent_same: true,
    permanent_address: '', permanent_city: '', permanent_state: '',
    permanent_postal_code: '', permanent_country: 'IN',

    department_id: '', designation_id: '', team_id: '', manager_id: '',
    employment_type: 'full_time', work_location: '', grade: '',
    probation_months: '6', notice_period_days: '30', bgv_status: '',

    attendance_type: 'office', shift_id: '', schedule_id: '', can_punch_anywhere: false,

    gross_monthly: '', salary_from: '', salary_components: [], fixed_amounts: {},
    pan: '', aadhaar: '', uan: '', pf_number: '', esi_number: '',
    bank_name: '', bank_branch: '', bank_ifsc: '', bank_account: '',
    bank_account_confirm: '', bank_account_name: '',

    asset_ids: [], asset_note: '',
    documents: [],

    role_id: '', role: 'employee', console_access: true, password: '',
    // The same defaults the old inline form used: everything on except the two
    // that remove a control or expose pay.
    permissions: Object.fromEntries(
      PERMISSIONS.map((p) => [p.key, p.key !== 'can_punch_anywhere' && p.key !== 'can_manage_payroll']),
    ) as Record<PermissionKey, boolean>,
    hidden_pages: [],

    start_onboarding: true, onboarding_template_id: '',
  }
}

export function fullName(d: HireDraft): string {
  return [d.first_name, d.middle_name, d.last_name].map((s) => s.trim()).filter(Boolean).join(' ')
}

/* ----------------------------------------------------------------- edit --- */

/** The statutory values the server holds but only ever returns masked. The
 *  edit form shows them as "on file" and leaves the inputs empty: typing a new
 *  number replaces it, leaving the field blank keeps it. */
export interface OnFile {
  pan: string | null
  aadhaar: string | null
  bank_account: string | null
}

/** The account stores one full name; the form wants three parts. The first
 *  word and the last word, with whatever sits between as the middle name. */
function splitName(full: string): Pick<HireDraft, 'first_name' | 'middle_name' | 'last_name'> {
  const words = full.trim().split(/\s+/).filter(Boolean)
  if (words.length <= 1) return { first_name: words[0] ?? '', middle_name: '', last_name: '' }
  return {
    first_name: words[0],
    middle_name: words.slice(1, -1).join(' '),
    last_name: words[words.length - 1],
  }
}

/** An existing employee as a draft, so the same ten steps can edit them. */
export function draftFromEmployee(user: User, profile: EmployeeProfile | null, shiftId: string): HireDraft {
  const base = emptyDraft()
  const pr = profile
  const v = (x: string | null | undefined) => x ?? ''
  const permanentSame = !pr?.permanent_address && !pr?.permanent_city
    || (pr?.permanent_address === pr?.current_address && pr?.permanent_city === pr?.current_city)
  const status = user.status === 'pending_setup' || user.status === 'inactive' ? user.status : 'active'
  return {
    ...base,
    ...splitName(user.full_name),
    email: user.email,
    phone: v(user.phone),
    employee_code: v(user.employee_code),
    joined_on: v(user.joined_on),
    status,
    is_active: user.is_active,
    timezone: v(user.timezone),

    date_of_birth: v(pr?.date_of_birth), gender: v(pr?.gender), marital_status: v(pr?.marital_status),
    blood_group: v(pr?.blood_group), nationality: v(pr?.nationality), father_name: v(pr?.father_name),
    personal_email: v(pr?.personal_email), alternate_phone: v(pr?.alternate_phone),
    emergency_name: v(pr?.emergency_name), emergency_relationship: v(pr?.emergency_relationship),
    emergency_phone: v(pr?.emergency_phone),

    current_address: v(pr?.current_address), current_city: v(pr?.current_city),
    current_state: v(pr?.current_state), current_postal_code: v(pr?.current_postal_code),
    current_country: v(pr?.current_country),
    permanent_same: permanentSame,
    permanent_address: v(pr?.permanent_address), permanent_city: v(pr?.permanent_city),
    permanent_state: v(pr?.permanent_state), permanent_postal_code: v(pr?.permanent_postal_code),
    permanent_country: v(pr?.permanent_country),

    department_id: v(user.department_id), designation_id: v(user.designation_id),
    team_id: v(user.team_id), manager_id: v(user.manager_id),
    employment_type: v(pr?.employment_type), work_location: v(pr?.work_location), grade: v(pr?.grade),
    probation_months: pr?.probation_months == null ? '' : String(pr.probation_months),
    notice_period_days: pr?.notice_period_days == null ? '' : String(pr.notice_period_days),
    bgv_status: v(pr?.bgv_status),

    attendance_type: pr?.attendance_type || 'office',
    shift_id: shiftId,
    schedule_id: v(user.schedule_id),
    can_punch_anywhere: user.can_punch_anywhere,

    uan: v(pr?.uan), pf_number: v(pr?.pf_number), esi_number: v(pr?.esi_number),
    bank_name: v(pr?.bank_name), bank_branch: v(pr?.bank_branch), bank_ifsc: v(pr?.bank_ifsc),
    bank_account_name: v(pr?.bank_account_name),

    role_id: v(user.role_id),
    role: user.role,
    console_access: true,
    permissions: Object.fromEntries(
      // Payroll grants rather than restricts, so only an explicit true is on.
      PERMISSIONS.map((p) => {
        const held = (user as unknown as Record<string, unknown>)[p.key]
        return [p.key, p.key === 'can_manage_payroll' ? held === true : held !== false]
      }),
    ) as Record<PermissionKey, boolean>,
    hidden_pages: user.hidden_pages ?? [],

    start_onboarding: false,
  }
}

/** The fields of `keys` whose value differs between the two drafts, with ''
 *  sent as null — on an edit, emptying a field means clearing it. */
export function changed(
  before: HireDraft, after: HireDraft, keys: Array<keyof HireDraft>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue
    const value = after[k]
    out[k] = typeof value === 'string' ? (value.trim() === '' ? null : value.trim()) : value
  }
  return out
}

/* ----------------------------------------------------------------- steps --- */

export type StepId =
  | 'basic' | 'personal' | 'address' | 'job' | 'attendance'
  | 'pay' | 'assets' | 'documents' | 'access' | 'review'

export interface StepDef {
  id: StepId
  label: string
  hint: string
  optional?: boolean
}

export const STEPS: StepDef[] = [
  { id: 'basic', label: 'Basic details', hint: 'Name, work email, joining date' },
  { id: 'personal', label: 'Personal details', hint: 'Birth, family, emergency contact', optional: true },
  { id: 'address', label: 'Address', hint: 'Current and permanent', optional: true },
  { id: 'job', label: 'Employment', hint: 'Department, role in the org, probation' },
  { id: 'attendance', label: 'Attendance & shift', hint: 'Attendance type, shift, schedule' },
  { id: 'pay', label: 'Salary & statutory', hint: 'CTC, PAN, Aadhaar, bank', optional: true },
  { id: 'assets', label: 'Assets', hint: 'Laptop, ID card, SIM', optional: true },
  { id: 'documents', label: 'Documents', hint: 'Offer letter, ID proofs', optional: true },
  { id: 'access', label: 'Access & role', hint: 'Role, login, permissions' },
  { id: 'review', label: 'Review & create', hint: 'Check everything once' },
]

/* ------------------------------------------------------------ validation --- */

export type Errors = Partial<Record<string, string>>

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE = /^\+?[0-9\s-]{7,16}$/
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/
const AADHAAR = /^[0-9]{12}$/
const UAN = /^[0-9]{12}$/
const PIN = /^[0-9A-Za-z\s-]{3,10}$/

/** Every rule, keyed by field, grouped by the step that owns the field. */
export function validate(d: HireDraft): Record<StepId, Errors> {
  const e: Record<StepId, Errors> = {
    basic: {}, personal: {}, address: {}, job: {}, attendance: {},
    pay: {}, assets: {}, documents: {}, access: {}, review: {},
  }

  if (!d.first_name.trim()) e.basic.first_name = 'First name is required.'
  if (!d.email.trim()) e.basic.email = 'Work email is required.'
  else if (!EMAIL.test(d.email.trim())) e.basic.email = 'That is not a valid email address.'
  if (d.phone && !PHONE.test(d.phone.trim())) e.basic.phone = 'Use digits, spaces or dashes — 7 to 16.'
  if (!d.joined_on) e.basic.joined_on = 'Joining date is required.'

  if (d.date_of_birth) {
    const dob = new Date(d.date_of_birth)
    const age = (Date.now() - dob.getTime()) / (365.25 * 864e5)
    if (dob > new Date()) e.personal.date_of_birth = 'Date of birth cannot be in the future.'
    else if (age < 14) e.personal.date_of_birth = 'That makes them younger than 14.'
  }
  if (d.personal_email && !EMAIL.test(d.personal_email.trim()))
    e.personal.personal_email = 'That is not a valid email address.'
  if (d.personal_email && d.personal_email.trim().toLowerCase() === d.email.trim().toLowerCase())
    e.personal.personal_email = 'Use a personal address — the work one stops working when they leave.'
  if (d.alternate_phone && !PHONE.test(d.alternate_phone.trim()))
    e.personal.alternate_phone = 'Use digits, spaces or dashes — 7 to 16.'
  if (d.emergency_phone && !PHONE.test(d.emergency_phone.trim()))
    e.personal.emergency_phone = 'Use digits, spaces or dashes — 7 to 16.'
  if (d.emergency_phone && !d.emergency_name.trim())
    e.personal.emergency_name = 'Whose number is it?'

  if (d.current_postal_code && !PIN.test(d.current_postal_code.trim()))
    e.address.current_postal_code = 'Not a postal code.'
  if (!d.permanent_same && d.permanent_postal_code && !PIN.test(d.permanent_postal_code.trim()))
    e.address.permanent_postal_code = 'Not a postal code.'
  for (const key of ['current_country', 'permanent_country'] as const) {
    if (d[key] && !/^[A-Za-z]{2}$/.test(d[key])) e.address[key] = 'Two-letter country code, e.g. IN.'
  }

  const prob = d.probation_months.trim()
  if (prob && (!/^\d+$/.test(prob) || Number(prob) > 36)) e.job.probation_months = '0 to 36 months.'
  const notice = d.notice_period_days.trim()
  if (notice && (!/^\d+$/.test(notice) || Number(notice) > 365)) e.job.notice_period_days = '0 to 365 days.'

  if (d.gross_monthly) {
    const paise = toPaise(d.gross_monthly)
    if (!paise) e.pay.gross_monthly = 'Enter the monthly gross in rupees.'
    else if (!d.salary_components.length) e.pay.gross_monthly = 'Pick at least one pay component.'
  }
  if (d.pan && !PAN.test(d.pan)) e.pay.pan = 'PAN looks like ABCDE1234F.'
  if (d.aadhaar && !AADHAAR.test(d.aadhaar.replace(/\s/g, ''))) e.pay.aadhaar = 'Aadhaar is 12 digits.'
  if (d.uan && !UAN.test(d.uan)) e.pay.uan = 'UAN is 12 digits.'
  if (d.bank_ifsc && !IFSC.test(d.bank_ifsc)) e.pay.bank_ifsc = 'IFSC looks like HDFC0001234.'
  if (d.bank_account && !/^[0-9]{6,18}$/.test(d.bank_account)) e.pay.bank_account = '6 to 18 digits.'
  if (d.bank_account && d.bank_account !== d.bank_account_confirm)
    e.pay.bank_account_confirm = 'The two account numbers do not match.'
  if (d.bank_account && !d.bank_ifsc) e.pay.bank_ifsc = 'An account number needs its IFSC.'

  d.documents.forEach((doc) => {
    if (!doc.file) e.documents[`doc_${doc.key}`] = 'Choose a file, or remove this row.'
    else if (doc.file.size > 10 * 1024 * 1024) e.documents[`doc_${doc.key}`] = 'Larger than 10 MB.'
    if (doc.issued_on && doc.expires_on && doc.expires_on < doc.issued_on)
      e.documents[`doc_${doc.key}`] = 'Expires before it was issued.'
  })

  if (!d.role_id) e.access.role_id = 'Choose a role.'
  if (d.console_access && d.password && d.password.length < 8)
    e.access.password = 'At least 8 characters.'

  return e
}

export function countErrors(errors: Errors): number {
  return Object.keys(errors).length
}

/* --------------------------------------------------------------- helpers --- */

/** Strip empties so a PATCH never sends "" where the server expects null or an enum. */
export function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== '' && v !== null && v !== undefined),
  )
}

export function addMonths(iso: string, months: number): string {
  const d = new Date(iso + 'T00:00:00')
  const day = d.getDate()
  d.setMonth(d.getMonth() + months)
  // 31 Jan + 1 month lands on 3 Mar in JS; clamp to the last day instead.
  if (d.getDate() < day) d.setDate(0)
  return d.toISOString().slice(0, 10)
}

/**
 * The next employee code, from the codes already in use.
 *
 * Takes the most common prefix ("EMP-", "LRS") and the highest number under
 * it. A suggestion, not a reservation — two admins hiring at once can collide,
 * and the field stays editable for exactly that reason.
 */
export function suggestCode(codes: Array<string | null>): string {
  const parsed = codes
    .map((c) => (c ?? '').trim().match(/^(.*?)(\d+)$/))
    .filter((m): m is RegExpMatchArray => !!m)
  if (!parsed.length) return 'EMP-001'
  const byPrefix = new Map<string, { max: number; width: number; n: number }>()
  for (const m of parsed) {
    const entry = byPrefix.get(m[1]) ?? { max: 0, width: m[2].length, n: 0 }
    entry.max = Math.max(entry.max, Number(m[2]))
    entry.width = Math.max(entry.width, m[2].length)
    entry.n += 1
    byPrefix.set(m[1], entry)
  }
  const [prefix, best] = [...byPrefix.entries()].sort((a, b) => b[1].n - a[1].n)[0]
  return prefix + String(best.max + 1).padStart(best.width, '0')
}

export const EMPLOYMENT_TYPES = [
  { value: 'full_time', label: 'Full-time' },
  { value: 'part_time', label: 'Part-time' },
  { value: 'contract', label: 'Contract' },
  { value: 'intern', label: 'Intern' },
  { value: 'consultant', label: 'Consultant' },
]

export const ATTENDANCE_TYPES = [
  {
    value: 'office',
    label: 'Office',
    desc: 'Works from a company office. Punches are checked against the office geofence.',
  },
  {
    value: 'hybrid',
    label: 'Hybrid',
    desc: 'Some days in office, some from home. They choose the work mode at each punch.',
  },
  {
    value: 'remote',
    label: 'Remote',
    desc: 'Works from home full-time. The work-from-home geofence rule applies.',
  },
  {
    value: 'field',
    label: 'Field / on-duty',
    desc: 'Sales, service or drivers — out at sites. Usually allowed to punch from anywhere.',
  },
]

export const DOC_TYPES = [
  { value: 'offer_letter', label: 'Offer letter' },
  { value: 'appointment_letter', label: 'Appointment letter' },
  { value: 'pan_card', label: 'PAN card' },
  { value: 'aadhaar_card', label: 'Aadhaar card' },
  { value: 'passport', label: 'Passport' },
  { value: 'driving_licence', label: 'Driving licence' },
  { value: 'education', label: 'Education certificate' },
  { value: 'experience_letter', label: 'Previous experience letter' },
  { value: 'relieving_letter', label: 'Relieving letter' },
  { value: 'payslip', label: 'Previous payslip' },
  { value: 'bank_proof', label: 'Cancelled cheque / bank proof' },
  { value: 'photo', label: 'Photograph' },
  { value: 'other', label: 'Other' },
]

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']

export const RELATIONSHIPS = ['Father', 'Mother', 'Spouse', 'Sibling', 'Son', 'Daughter', 'Friend', 'Other']

export const BGV_STATUSES = [
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'cleared', label: 'Cleared' },
  { value: 'flagged', label: 'Flagged' },
]
