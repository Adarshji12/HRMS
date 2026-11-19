/**
 * Which fields of the Add / Edit employee steps a person may show, make
 * mandatory or hide (Settings, top right of the form), and how each part of a
 * step is arranged.
 *
 * Every key is the draft key of the field, so the step components look their
 * mode up by the same name they bind the input to. A step's sub-sections (Name,
 * Work contact, Joining ...) are each their own part of the form: arranging
 * moves a field within its own part and never across the headings.
 *
 * Bespoke parts of a step are not listed and stay as they are: the attendance
 * type cards, the role cards' contents, the pay component picker, the asset and
 * document lists, the per-person restrictions and the review page.
 *
 * `fixed` is what the server needs to create the account (name and work email).
 * The joining date and the role are insisted on by this form but the server
 * accepts them empty, so they start mandatory and can be relaxed.
 */
import type { FieldDef, FieldMode, FieldSection } from '../../../../components/ViewSettings'
import type { Errors, HireDraft, StepId } from './hireModel'

export const HIRE_SECTIONS: FieldSection[] = [
  { id: 'basic-name', label: 'Basic details · Name' },
  { id: 'basic-contact', label: 'Basic details · Work contact' },
  { id: 'basic-joining', label: 'Basic details · Joining' },
  { id: 'personal-info', label: 'Personal details · Personal information' },
  { id: 'personal-contact', label: 'Personal details · Personal contact' },
  { id: 'personal-emergency', label: 'Personal details · Emergency contact' },
  { id: 'address-current', label: 'Address · Current address' },
  { id: 'address-permanent', label: 'Address · Permanent address' },
  { id: 'job-position', label: 'Employment · Position in the organisation' },
  { id: 'job-terms', label: 'Employment · Employment terms' },
  { id: 'attendance-shift', label: 'Attendance & shift · Shift and schedule' },
  { id: 'pay-salary', label: 'Salary & statutory · Salary' },
  { id: 'pay-statutory', label: 'Salary & statutory · Statutory' },
  { id: 'pay-bank', label: 'Salary & statutory · Bank account' },
  { id: 'access', label: 'Access & role' },
]

const f = (section: string, key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
  ({ key, label, section, ...extra })

export const HIRE_FIELDS: FieldDef[] = [
  f('basic-name', 'first_name', 'First name', { fixed: true }),
  f('basic-name', 'middle_name', 'Middle name'),
  f('basic-name', 'last_name', 'Last name'),
  f('basic-contact', 'email', 'Work email', { fixed: true }),
  f('basic-contact', 'phone', 'Mobile number'),
  f('basic-joining', 'employee_code', 'Employee ID'),
  f('basic-joining', 'joined_on', 'Date of joining', { initial: 'mandatory' }),
  f('basic-joining', 'status', 'Status'),
  f('basic-joining', 'timezone', 'Time zone'),

  f('personal-info', 'date_of_birth', 'Date of birth'),
  f('personal-info', 'gender', 'Gender'),
  f('personal-info', 'marital_status', 'Marital status'),
  f('personal-info', 'blood_group', 'Blood group'),
  f('personal-info', 'nationality', 'Nationality'),
  f('personal-info', 'father_name', 'Father’s / spouse’s name'),
  f('personal-contact', 'personal_email', 'Personal email'),
  f('personal-contact', 'alternate_phone', 'Alternate phone'),
  f('personal-emergency', 'emergency_name', 'Contact name'),
  f('personal-emergency', 'emergency_relationship', 'Relationship'),
  f('personal-emergency', 'emergency_phone', 'Contact phone'),

  f('address-current', 'current_address', 'Address'),
  f('address-current', 'current_country', 'Country'),
  f('address-current', 'current_state', 'State'),
  f('address-current', 'current_city', 'City'),
  f('address-current', 'current_postal_code', 'PIN / postal code'),
  f('address-permanent', 'permanent_address', 'Address'),
  f('address-permanent', 'permanent_country', 'Country'),
  f('address-permanent', 'permanent_state', 'State'),
  f('address-permanent', 'permanent_city', 'City'),
  f('address-permanent', 'permanent_postal_code', 'PIN / postal code'),

  f('job-position', 'department_id', 'Department'),
  f('job-position', 'designation_id', 'Designation'),
  f('job-position', 'team_id', 'Team'),
  f('job-position', 'manager_id', 'Reporting manager'),
  f('job-terms', 'employment_type', 'Employment type'),
  f('job-terms', 'work_location', 'Work location'),
  f('job-terms', 'grade', 'Grade / band'),
  f('job-terms', 'probation_months', 'Probation (months)'),
  f('job-terms', 'notice_period_days', 'Notice period (days)'),
  f('job-terms', 'bgv_status', 'Background verification'),

  f('attendance-shift', 'shift_id', 'Shift'),
  f('attendance-shift', 'schedule_id', 'Work schedule'),

  f('pay-salary', 'gross_monthly', 'Monthly gross (₹)'),
  f('pay-salary', 'salary_from', 'Effective from', { optionalOnly: true }),
  f('pay-statutory', 'pan', 'PAN'),
  f('pay-statutory', 'aadhaar', 'Aadhaar'),
  f('pay-statutory', 'uan', 'UAN'),
  f('pay-statutory', 'pf_number', 'PF number'),
  f('pay-statutory', 'esi_number', 'ESI number'),
  f('pay-bank', 'bank_account_name', 'Account holder name'),
  f('pay-bank', 'bank_account', 'Account number'),
  f('pay-bank', 'bank_account_confirm', 'Confirm account number'),
  f('pay-bank', 'bank_ifsc', 'IFSC'),
  f('pay-bank', 'bank_name', 'Bank name'),
  f('pay-bank', 'bank_branch', 'Branch'),

  f('access', 'role_id', 'Role', { initial: 'mandatory' }),
]

/** The step each part of the form belongs to. */
const STEP_OF = (section: string): StepId => section.split('-')[0] as StepId

/**
 * Lay a person's Show / Mandatory / Hide choices over the errors `validate`
 * produced. A hidden field is not validated at all; a mandatory one that is
 * empty is an error, but only when the field is actually on screen (a step the
 * person has no permission for, the permanent address while it is the same as
 * the current one, or the salary when no pay components exist show nothing
 * to fill in, so they cannot block a save).
 */
export function applyFieldModes(
  errors: Record<StepId, Errors>,
  d: HireDraft,
  mode: (key: string) => FieldMode,
  ctx: { people: boolean; salary: boolean; excuse: string[] },
): Record<StepId, Errors> {
  const onScreen = (section: string) => {
    if (section.startsWith('personal') || section === 'job-terms' || section === 'pay-statutory' || section === 'pay-bank') return ctx.people
    if (section === 'address-current') return ctx.people
    if (section === 'address-permanent') return ctx.people && !d.permanent_same
    if (section === 'pay-salary') return ctx.salary
    return true
  }
  for (const def of HIRE_FIELDS) {
    const step = errors[STEP_OF(def.section)]
    const m = mode(def.key)
    if (def.fixed) continue
    if (m === 'hide') {
      delete step[def.key]
      continue
    }
    const empty = String((d as unknown as Record<string, unknown>)[def.key] ?? '').trim() === ''
    if (def.initial === 'mandatory' && m !== 'mandatory') {
      // Relaxed by the person: the form's own "required" no longer applies.
      if (empty) delete step[def.key]
      continue
    }
    if (m === 'mandatory' && empty && !step[def.key] && !ctx.excuse.includes(def.key) && onScreen(def.section)) {
      step[def.key] = `${def.label} is required.`
    }
  }
  return errors
}
