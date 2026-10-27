/**
 * Add Employee — the whole hire in one place.
 *
 * A page rather than the card that used to unfold above the roster: ten
 * sections do not fit in a card, and HR filling in a new joiner's bank details
 * should not have the full employee table scrolling underneath them.
 *
 * Sections can be visited in any order from the left rail. Only Basic details
 * and Role are required to create the account; everything else is optional at
 * this point and editable afterwards from the HR record, which is what lets an
 * administrator add somebody before their PAN card has arrived.
 *
 * Submission is a sequence, not a transaction — see hireModel.ts for why. The
 * progress screen shows every call, and a failed one can be retried without
 * re-creating the account.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../../../../lib/api'
import { useAuth, isOwner } from '../../../../lib/auth'
import { toPaise } from '../../../../lib/format'
import { useQuery } from '../../../../lib/useQuery'
import type { Department, Designation, EmployeeProfile, PayComponent, Team, User, WorkSchedule } from '../../../../lib/types'
import type { OrgRole } from '../../roles/Roles'
import type { Asset } from '../../assets/assetLib'
import type { HrSettings } from '../../HRMSSettings'
import { ErrorNote, Loading } from '../../../../components/ui'
import { Dialog } from '../../../crm/parts'
import {
  STEPS, addMonths, changed, compact, countErrors, draftFromEmployee, emptyDraft, fullName, suggestCode, validate,
  type HireDraft, type OnFile, type StepId,
} from './hireModel'
import {
  AccessStep, AddressStep, AssetsStep, AttendanceStep, BasicStep, DocumentsStep, JobStep,
  PayStep, PersonalStep, ReviewStep,
  type Capabilities, type Lookups, type OnboardingTemplate, type Shift, type StepProps,
} from './HireSteps'
import '../../../../styles/org.css'
import '../../../../styles/hire.css'
import '../../../../styles/crm.css'

/* Optional lookups resolve to [] on failure: a company with no payroll access
   should still be able to hire, and the step that needed the list explains. */
const soft = <T,>(p: Promise<T[]>) => p.catch(() => [] as T[])

type TaskState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
interface Task {
  id: string
  label: string
  state: TaskState
  error?: string
  run: (userId: string) => Promise<unknown>
}

/** What an edit starts from: the account, its HR record and its current shift. */
interface EditSource {
  profile: EmployeeProfile | null
  shiftId: string
}

/**
 * The same ten steps also edit an existing employee, on its own page at
 * /employees/:userId/edit (EditEmployee below). The draft is filled from what is on
 * file, and saving sends each module only the fields that changed — the
 * account, the HR record, employment terms — plus whatever was added: a new
 * shift, a salary revision, assets, documents.
 */
/** The sections the Edit dialog shows. */
const DIALOG_STEPS: StepId[] = ['basic']

export default function AddEmployee() {
  return <HireForm />
}

/** /employees/:userId/edit — Add employee's ten steps, filled from the record.
 *  Keyed by the id so moving between two people's edit pages starts fresh. */
export function EditEmployee() {
  const { userId = '' } = useParams()
  return <HireForm key={userId} editId={userId} />
}

/** Opened as a dialog rather than a page: closes instead of navigating. */
export interface HireDialog {
  onClose: () => void
  onSaved: () => void
}

export function HireForm({ editId, dialog }: { editId?: string; dialog?: HireDialog }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const editing = !!editId
  const close = () => (dialog ? dialog.onClose() : navigate('/employees'))

  const can: Capabilities = {
    people: user?.can_manage_people !== false,
    payroll: isOwner(user) || user?.can_manage_payroll === true,
    assets: user?.can_manage_assets !== false,
    // An onboarding checklist belongs to a hire, not to an edit.
    onboarding: !editing && user?.can_manage_onboarding !== false,
  }

  const lookups = useQuery<Lookups>('hire-lookups', async () => {
    const [teams, departments, designations, schedules, people, roles, shifts, components, assets, templates] =
      await Promise.all([
        api.get<Team[]>('/org/teams'),
        api.get<Department[]>('/org/departments'),
        api.get<Designation[]>('/org/designations'),
        soft(api.get<WorkSchedule[]>('/org/schedules')),
        api.get<User[]>('/admin/employees'),
        api.get<OrgRole[]>('/roles'),
        soft(api.get<Shift[]>('/attendance/shifts')),
        can.payroll ? soft(api.get<PayComponent[]>('/payroll/components?active_only=true')) : Promise.resolve([]),
        can.assets ? soft(api.get<Asset[]>('/assets?status=available')) : Promise.resolve([]),
        can.onboarding ? soft(api.get<OnboardingTemplate[]>('/onboarding/templates')) : Promise.resolve([]),
      ])
    return { teams, departments, designations, schedules, people, roles, shifts, components, assets, templates }
  })

  const source = useQuery<EditSource | null>(`hire-edit-${editId ?? ''}`, async () => {
    if (!editId) return null
    const [profile, shifts] = await Promise.all([
      can.people ? api.get<EmployeeProfile>(`/people/${editId}`).catch(() => null) : Promise.resolve(null),
      soft(api.get<Array<{ shift_id: string }>>(`/attendance/shift-assignments?user_id=${editId}&current_only=true`)),
    ])
    return { profile, shiftId: shifts[0]?.shift_id ?? '' }
  })

  const [d, setD] = useState<HireDraft>(emptyDraft)
  // What the edit started from, to send only what changed.
  const [original, setOriginal] = useState<HireDraft | null>(null)
  const employee = editing ? lookups.data?.people.find((p) => p.id === editId) : undefined
  const onFile: OnFile | undefined = source.data?.profile ? {
    pan: source.data.profile.has_pan ? source.data.profile.pan_masked : null,
    aadhaar: source.data.profile.has_aadhaar ? source.data.profile.aadhaar_masked : null,
    bank_account: source.data.profile.has_bank_account ? source.data.profile.bank_account_masked : null,
  } : undefined
  const [step, setStep] = useState<StepId>('basic')
  const [visited, setVisited] = useState<Set<StepId>>(() => new Set())
  const [dirty, setDirty] = useState(false)
  const set = useCallback((patch: Partial<HireDraft>) => {
    setD((prev) => ({ ...prev, ...patch }))
    setDirty(true)
  }, [])

  // HR Settings → General: the employee ID series and the default probation
  // and notice. Soft — without it the form falls back to its own defaults.
  const hrSettings = useQuery<HrSettings | null>('hire-hr-settings', () =>
    api.get<HrSettings>('/hr/settings').catch(() => null))

  // Defaults that depend on the lookups: the next employee code, and the
  // built-in Employee role — the right answer for most hires.
  const seeded = useRef(false)
  useEffect(() => {
    if (!editing || seeded.current || !employee || source.data === undefined) return
    seeded.current = true
    const draft = draftFromEmployee(employee, source.data?.profile ?? null, source.data?.shiftId ?? '')
    setD(draft)
    setOriginal(draft)
  }, [editing, employee, source.data])
  useEffect(() => {
    if (editing || seeded.current || !lookups.data || hrSettings.loading) return
    seeded.current = true
    const lk = lookups.data
    const hs = hrSettings.data
    const base = lk.roles.find((r) => r.base_role === 'employee' && r.is_builtin)
      ?? lk.roles.find((r) => r.base_role === 'employee')
    const defaultSchedule = lk.schedules.find((s) => s.is_default)
    setD((prev) => ({
      ...prev,
      ...(hs ? {
        probation_months: String(hs.default_probation_months),
        notice_period_days: String(hs.default_notice_days),
      } : {}),
      employee_code: prev.employee_code || hs?.next_code || suggestCode(lk.people.map((p) => p.employee_code)),
      role_id: prev.role_id || base?.id || '',
      role: prev.role_id ? prev.role : base?.base_role ?? 'employee',
      schedule_id: prev.schedule_id || defaultSchedule?.id || '',
    }))
  }, [lookups.data, hrSettings.loading, hrSettings.data])

  // After "Add another", the refetched series fills the emptied code field.
  // Keyed on the data, not the field, so clearing the field by hand (which
  // also means "mint one") does not get overwritten.
  useEffect(() => {
    const next = hrSettings.data?.next_code
    if (!editing && seeded.current && next) setD((prev) => (prev.employee_code ? prev : { ...prev, employee_code: next }))
  }, [hrSettings.data])

  // A half-typed hire is twenty minutes of somebody's work.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const errors = useMemo(() => {
    const e = validate(d)
    // Somebody created before named roles holds none; an edit need not force one.
    if (editing && !original?.role_id && !d.role_id) delete e.access.role_id
    // Likewise a joining date that was never recorded.
    if (editing && !original?.joined_on && !d.joined_on) delete e.basic.joined_on
    return e
  }, [d, editing, original])
  const index = STEPS.findIndex((s) => s.id === step)
  const required = countErrors(errors.basic) + countErrors(errors.access)
  const total = STEPS.reduce((n, s) => n + countErrors(errors[s.id]), 0)

  const bodyRef = useRef<HTMLDivElement>(null)
  const goTo = (next: StepId) => {
    setVisited((v) => new Set(v).add(step))
    setStep(next)
    bodyRef.current?.scrollTo({ top: 0 })
    window.scrollTo({ top: 0 })
  }
  const next = () => {
    setVisited((v) => new Set(v).add(step))
    if (countErrors(errors[step])) return
    if (index < STEPS.length - 1) goTo(STEPS[index + 1].id)
  }

  /* ------------------------------------------------------------ submit --- */

  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  type Add = (id: string, label: string, run: Task['run']) => void

  /** Salary, assets and documents: added the same way on a hire and an edit. */
  function extras(add: Add, salaryFrom: string, reason: string) {
    const gross = toPaise(d.gross_monthly)
    if (can.payroll && gross && d.salary_components.length) {
      add('salary', reason === 'Joining salary' ? 'Joining salary structure' : 'Salary revision', (id) => api.post(`/payroll/${id}`, {
        effective_from: salaryFrom,
        gross_monthly: gross,
        components: d.salary_components.map((cid) => {
          const c = lookups.data?.components.find((x) => x.id === cid)
          return {
            component_id: cid,
            amount: c?.calculation === 'fixed' ? toPaise(d.fixed_amounts[cid] ?? '') : null,
          }
        }),
        reason,
      }))
    }

    if (can.assets) {
      for (const assetId of d.asset_ids) {
        const a = lookups.data?.assets.find((x) => x.id === assetId)
        add(`asset-${assetId}`, `Issue ${a?.asset_tag ?? 'asset'}${a?.name ? ` — ${a.name}` : ''}`,
          (id) => api.post('/assets/assign', {
            asset_id: assetId, user_id: id, assigned_condition_note: d.asset_note.trim() || null,
          }))
      }
    }

    if (can.people) {
      for (const doc of d.documents) {
        if (!doc.file) continue
        const file = doc.file
        add(`doc-${doc.key}`, `Upload ${doc.title || file.name}`, (id) => {
          const form = new FormData()
          form.append('meta', JSON.stringify(compact({
            doc_type: doc.doc_type, title: doc.title.trim(), issued_on: doc.issued_on, expires_on: doc.expires_on,
          })))
          form.append('file', file)
          return api.upload(`/people/${id}/documents`, form)
        })
      }
    }
  }

  /** An edit: each module gets only the fields that changed. */
  function planEdit(o: HireDraft): Task[] {
    const t: Task[] = []
    const add: Add = (id, label, run) => t.push({ id, label, state: 'pending', run })
    const today = new Date().toISOString().slice(0, 10)

    const account: Record<string, unknown> = changed(o, d, [
      'phone', 'employee_code', 'joined_on', 'status', 'timezone', 'department_id', 'designation_id',
      'team_id', 'manager_id', 'schedule_id', 'can_punch_anywhere', 'hidden_pages', 'is_active',
    ])
    if (fullName(d) !== fullName(o)) account.full_name = fullName(d)
    if (d.role_id !== o.role_id && d.role_id) account.role_id = d.role_id
    for (const [key, on] of Object.entries(d.permissions)) {
      if (on !== o.permissions[key as keyof typeof o.permissions]) account[key] = on
    }
    if (d.password) account.password = d.password
    if (Object.keys(account).length) {
      add('account', 'Account, placement & access', (id) => api.patch(`/admin/employees/${id}`, account))
    }

    if (can.people) {
      // "Same as current" is stored as a copy, so compare the copy.
      const eff: HireDraft = d.permanent_same ? {
        ...d, permanent_address: d.current_address, permanent_city: d.current_city,
        permanent_state: d.current_state, permanent_postal_code: d.current_postal_code,
        permanent_country: d.current_country,
      } : d
      const personal: Record<string, unknown> = changed(o, eff, [
        'date_of_birth', 'gender', 'marital_status', 'blood_group', 'nationality', 'father_name',
        'personal_email', 'alternate_phone', 'emergency_name', 'emergency_relationship', 'emergency_phone',
        'current_address', 'current_city', 'current_state', 'current_postal_code', 'current_country',
        'permanent_address', 'permanent_city', 'permanent_state', 'permanent_postal_code', 'permanent_country',
        'uan', 'pf_number', 'esi_number', 'bank_name', 'bank_branch', 'bank_ifsc', 'bank_account_name',
      ])
      // Held masked, so the inputs start empty: only a typed value replaces one.
      if (d.pan) personal.pan = d.pan
      if (d.aadhaar) personal.aadhaar = d.aadhaar.replace(/\s/g, '')
      if (d.bank_account) personal.bank_account = d.bank_account
      if (Object.keys(personal).length) {
        add('personal', 'Personal, address, statutory & bank details', (id) => api.patch(`/people/${id}`, personal))
      }

      const employment: Record<string, unknown> = changed(o, d, [
        'employment_type', 'work_location', 'grade', 'attendance_type', 'bgv_status',
      ])
      for (const k of ['probation_months', 'notice_period_days'] as const) {
        if (d[k] !== o[k]) employment[k] = d[k] === '' ? null : Number(d[k])
      }
      const months = Number(d.probation_months || 0)
      if ((d.probation_months !== o.probation_months || d.joined_on !== o.joined_on) && months > 0 && d.joined_on) {
        employment.probation_end_on = addMonths(d.joined_on, months)
      }
      if (Object.keys(employment).length) {
        add('employment', 'Employment terms & attendance type', (id) => api.patch(`/people/${id}/employment`, employment))
      }
    }

    if (d.shift_id && d.shift_id !== o.shift_id) {
      const shift = lookups.data?.shifts.find((x) => x.id === d.shift_id)
      add('shift', `Shift: ${shift?.name ?? 'assigned'} from today`, (id) => api.post('/attendance/shift-assignments', {
        user_id: id, shift_id: d.shift_id, effective_from: today,
      }))
    }

    extras(add, d.salary_from || today, 'Salary revision')
    return t
  }

  function plan(): Task[] {
    const t: Task[] = []
    const add: Add = (id, label, run) => t.push({ id, label, state: 'pending', run })

    const personal = can.people ? compact({
      date_of_birth: d.date_of_birth, gender: d.gender, marital_status: d.marital_status,
      blood_group: d.blood_group, nationality: d.nationality.trim(), father_name: d.father_name.trim(),
      personal_email: d.personal_email.trim(), alternate_phone: d.alternate_phone.trim(),
      emergency_name: d.emergency_name.trim(), emergency_relationship: d.emergency_relationship,
      emergency_phone: d.emergency_phone.trim(),
      current_address: d.current_address.trim(), current_city: d.current_city.trim(),
      current_state: d.current_state.trim(), current_postal_code: d.current_postal_code.trim(),
      current_country: d.current_address || d.current_city ? d.current_country : '',
      ...(d.permanent_same
        ? d.current_address || d.current_city ? {
          permanent_address: d.current_address.trim(), permanent_city: d.current_city.trim(),
          permanent_state: d.current_state.trim(), permanent_postal_code: d.current_postal_code.trim(),
          permanent_country: d.current_country,
        } : {}
        : {
          permanent_address: d.permanent_address.trim(), permanent_city: d.permanent_city.trim(),
          permanent_state: d.permanent_state.trim(), permanent_postal_code: d.permanent_postal_code.trim(),
          permanent_country: d.permanent_address || d.permanent_city ? d.permanent_country : '',
        }),
      pan: d.pan, aadhaar: d.aadhaar.replace(/\s/g, ''), uan: d.uan, pf_number: d.pf_number.trim(),
      esi_number: d.esi_number.trim(),
      bank_name: d.bank_name.trim(), bank_branch: d.bank_branch.trim(), bank_ifsc: d.bank_ifsc,
      bank_account: d.bank_account,
      bank_account_name: d.bank_account ? (d.bank_account_name.trim() || fullName(d)) : '',
    }) : {}
    if (Object.keys(personal).length) {
      add('personal', 'Personal, address, statutory & bank details', (id) => api.patch(`/people/${id}`, personal))
    }

    if (can.people) {
      const months = Number(d.probation_months || 0)
      const employment = compact({
        employment_type: d.employment_type, work_location: d.work_location.trim(), grade: d.grade.trim(),
        attendance_type: d.attendance_type,
        probation_months: d.probation_months === '' ? '' : months,
        probation_end_on: months > 0 && d.joined_on ? addMonths(d.joined_on, months) : '',
        notice_period_days: d.notice_period_days === '' ? '' : Number(d.notice_period_days),
        bgv_status: d.bgv_status,
      })
      add('employment', 'Employment terms & attendance type', (id) => api.patch(`/people/${id}/employment`, employment))
      if (months > 0) {
        add('probation', `Probation of ${months} month${months === 1 ? '' : 's'}`,
          (id) => api.post(`/people/${id}/confirmation`, { status: 'probation', note: 'Started at hire.' }))
      }
    }

    if (d.shift_id) {
      const shift = lookups.data?.shifts.find((s) => s.id === d.shift_id)
      add('shift', `Shift: ${shift?.name ?? 'assigned'}`, (id) => api.post('/attendance/shift-assignments', {
        user_id: id, shift_id: d.shift_id, effective_from: d.joined_on,
      }))
    }

    extras(add, d.salary_from || d.joined_on, 'Joining salary')

    if (can.onboarding && d.start_onboarding) {
      add('onboarding', 'Onboarding checklist', (id) => api.post('/onboarding/instances', {
        user_id: id, template_id: d.onboarding_template_id || null, joining_date: d.joined_on,
      }))
    }
    return t
  }

  async function runTasks(list: Task[], userId: string) {
    setRunning(true)
    const out = [...list]
    for (let i = 0; i < out.length; i++) {
      if (out[i].state === 'done' || out[i].state === 'skipped') continue
      out[i] = { ...out[i], state: 'running', error: undefined }
      setTasks([...out])
      try {
        await out[i].run(userId)
        out[i] = { ...out[i], state: 'done' }
      } catch (err) {
        out[i] = { ...out[i], state: 'failed', error: err instanceof Error ? err.message : String(err) }
      }
      setTasks([...out])
    }
    setRunning(false)
  }

  async function save() {
    setVisited(new Set(STEPS.map((x) => x.id)))
    // The dialog shows only the basic details, so only those can stop a save:
    // a gap in a section that is not on screen would block it with nothing
    // visible to fix.
    if (dialog ? DIALOG_STEPS.some((id) => countErrors(errors[id])) : total) {
      // The dialog shows every section at once, so bring the first error into view.
      if (dialog) {
        setTimeout(() => document.querySelector('.hire-edit .has-error')?.scrollIntoView({ block: 'center' }), 0)
        return
      }
      const first = STEPS.find((x) => countErrors(errors[x.id]))
      if (first) setStep(first.id)
      return
    }
    if (!editId || !original) return
    setFatal(null)
    const list = planEdit(original)
    if (!list.length) { close(); return }
    setDirty(false)
    setCreatedId(editId)
    setTasks(list)
    await runTasks(list, editId)
  }

  async function create() {
    setVisited(new Set(STEPS.map((s) => s.id)))
    if (total) {
      const first = STEPS.find((s) => countErrors(errors[s.id]))
      if (first) setStep(first.id)
      return
    }
    setFatal(null)
    setRunning(true)
    try {
      const created = await api.post<User>('/admin/employees', {
        full_name: fullName(d),
        email: d.email.trim().toLowerCase(),
        phone: d.phone.trim() || null,
        employee_code: d.employee_code.trim() || null,
        joined_on: d.joined_on || null,
        status: d.status,
        timezone: d.timezone.trim() || 'UTC',
        role: d.role,
        role_id: d.role_id || null,
        department_id: d.department_id || null,
        designation_id: d.designation_id || null,
        team_id: d.team_id || null,
        manager_id: d.manager_id || null,
        schedule_id: d.schedule_id || null,
        password: d.console_access && d.password ? d.password : null,
        ...d.permissions,
        can_punch_anywhere: d.can_punch_anywhere,
        hidden_pages: d.hidden_pages,
      })
      setDirty(false)
      setCreatedId(created.id)
      const list = plan()
      setTasks(list)
      await runTasks(list, created.id)
    } catch (err) {
      setFatal(err instanceof Error ? err.message : 'Could not create the employee.')
      setRunning(false)
    }
  }

  /* ------------------------------------------------------------ render --- */

  // In the dialog a clean save just closes it; only a failure stays on screen.
  const savedClean = !!dialog && !!tasks && !running && tasks.every((t) => t.state === 'done')
  useEffect(() => {
    if (!savedClean || !dialog) return
    dialog.onSaved()
    dialog.onClose()
  }, [savedClean])

  const tryClose = () => {
    if (!dirty || window.confirm('Discard your changes?')) dialog?.onClose()
  }
  // The page renders bare. The dialog is the CRM's (Edit customer's) shell —
  // its styles are scoped under .crm, so the wrapper carries it here.
  const frame = (body: ReactNode, footer?: ReactNode) => dialog ? (
    <div className="crm">
      <Dialog title={`Edit ${employee?.full_name ?? 'employee'}`} subtitle={employee?.email}
              onClose={tryClose} footer={footer} wide>
        <div className="hire hire-edit">{body}</div>
      </Dialog>
    </div>
  ) : body

  if (lookups.error) return frame(<ErrorNote>{lookups.error}</ErrorNote>)
  if (!lookups.data) return frame(<Loading label="Preparing the form…" />)
  if (editing && !employee) return frame(<ErrorNote>That employee was not found.</ErrorNote>)
  if (editing && !original) return frame(<Loading label="Loading their record…" />)

  if (createdId && tasks) {
    if (savedClean) return null
    return frame(<Progress name={fullName(d)} userId={createdId} tasks={tasks} running={running} editing={editing}
                     onClose={dialog ? () => { dialog.onSaved(); dialog.onClose() } : undefined}
                     retry={() => runTasks(tasks, createdId)}
                     another={() => {
                       const hs = hrSettings.data
                       setD({ ...emptyDraft(), role_id: d.role_id, role: d.role,
                         ...(hs ? {
                           probation_months: String(hs.default_probation_months),
                           notice_period_days: String(hs.default_notice_days),
                         } : {}),
                         // With HR settings the server has moved its counter
                         // on; the refetch below fills the code back in.
                         employee_code: hs ? ''
                           : suggestCode([...lookups.data!.people.map((p) => p.employee_code), d.employee_code]) })
                       setTasks(null); setCreatedId(null); setVisited(new Set()); setStep('basic')
                       lookups.reload()
                       hrSettings.reload()
                     }} />)
  }

  const props: StepProps = {
    d, set, errors: errors[step], lk: lookups.data, can, touched: visited.has(step), goTo,
    editing, onFile,
  }
  const current = STEPS[index]
  const stepLabel = (s: (typeof STEPS)[number]) => (editing && s.id === 'review' ? 'Review & save' : s.label)
  const submit = editing ? save : create
  const submitLabel = editing ? (running ? 'Saving…' : 'Save changes') : (running ? 'Creating…' : 'Create employee')

  // Edit from the Employees list: just the basic details — name, work
  // contact, joining. The rest of the record is edited from the HR record.
  if (dialog) {
    return frame(
      <>
        {fatal && <ErrorNote>{fatal}</ErrorNote>}
        {STEPS.filter((x) => DIALOG_STEPS.includes(x.id)).map((x) => (
          <div key={x.id} className="hire-edit-step">
            <StepBody id={x.id} p={{ ...props, errors: errors[x.id], touched: visited.has(x.id) }} />
          </div>
        ))}
      </>,
      <>
        <button type="button" className="btn" onClick={tryClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={running} onClick={save}>{submitLabel}</button>
      </>,
    )
  }

  const form = (
    <>
      <div className="hire-top">
        <div className="hire-top-text">
          <nav className="hire-crumbs" aria-label="Breadcrumb">
            <Link to="/employees">Employees</Link> <span aria-hidden>/</span> <span>{editing ? employee?.full_name : 'New employee'}</span>
          </nav>
          <h1 className="hire-title">{editing ? 'Edit employee' : 'Add employee'}</h1>
          <p className="hire-sub">
            Only basic details and a role are needed to create the account. Everything else can be filled now or later from the HR record.
          </p>
        </div>
        <div className="hire-top-side">
          <div className="hire-meter" aria-label="Progress">
            <div className="hire-meter-row">
              <span>Sections reviewed</span>
              <strong>{Math.min(visited.size + (visited.has(step) ? 0 : 1), STEPS.length)} / {STEPS.length}</strong>
            </div>
            <div className="hire-meter-bar">
              <span style={{ width: `${(Math.min(visited.size + (visited.has(step) ? 0 : 1), STEPS.length) / STEPS.length) * 100}%` }} />
            </div>
            <span className={`hire-ready${required ? '' : ' is-ok'}`}>
              {required ? `${required} required field${required === 1 ? '' : 's'} left` : editing ? 'Ready to save' : 'Ready to create'}
            </span>
          </div>
        <div className="hire-top-actions">
          <button type="button" className="btn" onClick={() => {
            if (!dirty || window.confirm(editing
              ? 'Discard your changes?'
              : 'Discard this employee? What you have entered will be lost.')) close()
          }}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={running || required > 0} onClick={submit}
                  title={required ? 'Fill basic details and choose a role first' : undefined}>
            {submitLabel}
          </button>
        </div>
        </div>
      </div>

      {fatal && <div style={{ marginBottom: 16 }}><ErrorNote>{fatal}</ErrorNote></div>}

      <div className="hire-layout">
        <nav className="hire-rail" aria-label="Sections">
          <ol className="hire-steps">
            {STEPS.map((s, i) => {
              const n = countErrors(errors[s.id])
              const seen = visited.has(s.id)
              const state = s.id === step ? 'current' : seen && n ? 'error' : seen ? 'done' : 'todo'
              return (
                <li key={s.id} className={`is-${state}`}>
                  <button type="button" className={`hire-step is-${state}`} onClick={() => goTo(s.id)}
                          aria-current={s.id === step ? 'step' : undefined} title={s.hint}>
                    <span className="hire-step-dot" aria-hidden>
                      {state === 'done' ? '✓' : state === 'error' ? '!' : i + 1}
                    </span>
                    <span className="hire-step-text">
                      <span className="hire-step-label">{stepLabel(s)}</span>
                      {s.optional && <span className="hire-optional">Optional</span>}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>

        <div className="hire-main card" ref={bodyRef}>
          <header className="hire-main-head">
            <div className="hire-main-title">
              <span className="hire-step-count">
                Step {index + 1} of {STEPS.length}
                {current.optional && <span className="hire-optional-tag">Optional</span>}
              </span>
              <h2>{stepLabel(current)}</h2>
              <p className="hire-main-hint">{current.hint}</p>
            </div>
            <HeaderCard d={d} lk={lookups.data} />
          </header>

          <div className="hire-body">
            {step === 'review'
              ? <ReviewStep {...props} allErrors={errors} touched />
              : <StepBody id={step} p={props} />}
          </div>

          <footer className="hire-foot">
            <button type="button" className="btn" disabled={index === 0}
                    onClick={() => goTo(STEPS[index - 1].id)}>Back</button>
            <span className="hire-foot-note">
              {visited.has(step) && countErrors(errors[step])
                ? `${countErrors(errors[step])} field${countErrors(errors[step]) === 1 ? '' : 's'} need attention`
                : current.optional && !editing ? 'You can skip this section.' : ''}
            </span>
            {step === 'review' ? (
              <button type="button" className="btn btn-primary" disabled={running} onClick={submit}>
                {submitLabel}
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={next}>
                {editing ? 'Next' : current.optional && isBlank(step, d) ? 'Skip' : 'Save & continue'}
              </button>
            )}
          </footer>
        </div>
      </div>
    </>
  )
  return <div className="hire hire-page">{form}</div>
}

/** One step's fields. The review step takes more than StepProps and is rendered by the caller. */
function StepBody({ id, p }: { id: StepId; p: StepProps }) {
  switch (id) {
    case 'basic': return <BasicStep {...p} />
    case 'personal': return <PersonalStep {...p} />
    case 'address': return <AddressStep {...p} />
    case 'job': return <JobStep {...p} />
    case 'attendance': return <AttendanceStep {...p} />
    case 'pay': return <PayStep {...p} />
    case 'assets': return <AssetsStep {...p} />
    case 'documents': return <DocumentsStep {...p} />
    case 'access': return <AccessStep {...p} />
    default: return null
  }
}

function isBlank(step: StepId, d: HireDraft): boolean {
  const empty = emptyDraft()
  const keys: Record<string, Array<keyof HireDraft>> = {
    personal: ['date_of_birth', 'gender', 'marital_status', 'blood_group', 'father_name', 'personal_email',
      'alternate_phone', 'emergency_name', 'emergency_phone'],
    address: ['current_address', 'current_city', 'current_state', 'current_postal_code',
      'permanent_address', 'permanent_city'],
    pay: ['gross_monthly', 'pan', 'aadhaar', 'uan', 'pf_number', 'esi_number', 'bank_account', 'bank_ifsc'],
    assets: ['asset_ids'],
    documents: ['documents'],
  }
  return (keys[step] ?? []).every((k) => JSON.stringify(d[k]) === JSON.stringify(empty[k]))
}

/** The live preview in the step header — who is being created, as they will appear. */
function HeaderCard({ d, lk }: { d: HireDraft; lk: Lookups }) {
  const name = fullName(d)
  const initials = name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
  const designation = lk.designations.find((x) => x.id === d.designation_id)?.name
  const department = lk.departments.find((x) => x.id === d.department_id)?.name
  return (
    <div className="hire-preview">
      <span className="hire-avatar" aria-hidden>{initials || '?'}</span>
      <div className="hire-preview-body">
        <strong>{name || 'New employee'}</strong>
        <span>{[designation, department].filter(Boolean).join(' · ') || d.email || 'Details appear here as you type'}</span>
        {d.employee_code && <span className="hire-code">{d.employee_code}</span>}
      </div>
    </div>
  )
}

function Progress({
  name, userId, tasks, running, editing, onClose, retry, another,
}: {
  name: string
  userId: string
  tasks: Task[]
  running: boolean
  editing: boolean
  /** In a dialog: one Close in place of the links away. */
  onClose?: () => void
  retry: () => void
  another: () => void
}) {
  const failed = tasks.filter((t) => t.state === 'failed').length
  const done = !running
  return (
    <div className="hire hire-done">
      <div className="card hire-result">
        <div className={`hire-result-icon${done && !failed ? ' is-ok' : failed ? ' is-warn' : ''}`} aria-hidden>
          {done ? (failed ? '!' : '✓') : '…'}
        </div>
        <h1 className="page-title">
          {editing
            ? !done ? `Saving ${name}…` : failed ? `${failed} change${failed === 1 ? '' : 's'} could not be saved` : `${name} is updated`
            : !done ? `Setting up ${name}…` : failed ? `${name} was created — ${failed} step${failed === 1 ? '' : 's'} need attention` : `${name} is set up`}
        </h1>
        <p className="page-sub">
          {!done ? 'Applying each section through the module that owns it.'
            : failed ? (editing
              ? 'Everything else was saved. Retry the failed steps, or change them later from the HR record.'
              : 'The account exists. Retry the failed steps, or finish them later from the HR record.')
              : editing ? 'Every change has been saved.' : 'The account, HR record and everything you entered have been saved.'}
        </p>

        <ul className="hire-tasks">
          {!editing && <li className="hire-task is-done"><span className="hire-task-dot">✓</span><span>Account &amp; organisation placement</span></li>}
          {tasks.map((t) => (
            <li key={t.id} className={`hire-task is-${t.state}`}>
              <span className="hire-task-dot">
                {t.state === 'done' ? '✓' : t.state === 'failed' ? '✕' : t.state === 'running' ? '' : '·'}
              </span>
              <span>
                {t.label}
                {t.error && <span className="hire-task-error">{t.error}</span>}
              </span>
            </li>
          ))}
        </ul>

        {done && (
          <div className="hire-result-actions">
            {failed > 0 && <button type="button" className="btn btn-primary" onClick={retry}>Retry failed</button>}
            {onClose ? <button type="button" className="btn" onClick={onClose}>Close</button> : <>
            <Link className={`btn${failed ? '' : ' btn-primary'}`} to={`/people/${userId}`}>Open HR record</Link>
            {!editing && <button type="button" className="btn" onClick={another}>Add another</button>}
            <Link className="btn btn-ghost" to="/employees">Back to employees</Link>
            </>}
          </div>
        )}
      </div>
    </div>
  )
}
