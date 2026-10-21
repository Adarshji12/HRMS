/**
 * The body of each step of the Add Employee form.
 *
 * Every step is a plain function of the draft: it reads `d`, writes through
 * `set`, and shows the errors `validate` produced for it. None of them talk to
 * the server — the shell loads the lookups once and submits once — so a step
 * can be revisited from the review page without refetching anything.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { PAGES, PERMISSIONS } from '../../../../lib/employeeFields'
import { money, toPaise } from '../../../../lib/format'
import type { Department, Designation, PayComponent, Team, User, WorkSchedule } from '../../../../lib/types'
import type { OrgRole } from '../../roles/Roles'
import type { Asset } from '../../assets/assetLib'
import {
  ATTENDANCE_TYPES, BGV_STATUSES, BLOOD_GROUPS, DOC_TYPES, EMPLOYMENT_TYPES, RELATIONSHIPS,
  addMonths, fullName, type Errors, type HireDraft, type StepId,
} from './hireModel'

export interface Shift {
  id: string
  name: string
  start_time: string
  end_time: string
  is_night_shift: boolean
  is_active: boolean
}

export interface OnboardingTemplate {
  id: string
  name: string
  department_id?: string | null
  is_active?: boolean
}

export interface Lookups {
  teams: Team[]
  departments: Department[]
  designations: Designation[]
  schedules: WorkSchedule[]
  people: User[]
  roles: OrgRole[]
  shifts: Shift[]
  components: PayComponent[]
  assets: Asset[]
  templates: OnboardingTemplate[]
}

export interface Capabilities {
  people: boolean
  payroll: boolean
  assets: boolean
  onboarding: boolean
}

export interface StepProps {
  d: HireDraft
  set: (patch: Partial<HireDraft>) => void
  errors: Errors
  lk: Lookups
  can: Capabilities
  /** Show errors only after the person has tried to move on. */
  touched: boolean
  goTo: (step: StepId) => void
}

/* ---------------------------------------------------------------- fields --- */

function Field({
  label, error, hint, required, wide, children,
}: {
  label: string
  error?: string
  hint?: ReactNode
  required?: boolean
  wide?: boolean
  children: ReactNode
}) {
  return (
    <label className={`hire-field${wide ? ' hire-field-wide' : ''}${error ? ' has-error' : ''}`}>
      <span className="hire-label">
        {label}
        {required && <span className="hire-req" aria-hidden>*</span>}
      </span>
      {children}
      {error ? (
        <span className="hire-error" role="alert">{error}</span>
      ) : hint ? (
        <span className="hire-hint">{hint}</span>
      ) : null}
    </label>
  )
}

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="hire-section">
      <header className="hire-section-head">
        <h3>{title}</h3>
        {desc && <p>{desc}</p>}
      </header>
      <div className="hire-grid">{children}</div>
    </section>
  )
}

/** `e` only once the step has been attempted, so an empty form is not a red one. */
const shown = (p: StepProps, key: string) => (p.touched ? p.errors[key] : undefined)

function Text({
  p, k, label, required, hint, type = 'text', placeholder, upper, wide, maxLength, inputMode,
}: {
  p: StepProps
  k: keyof HireDraft
  label: string
  required?: boolean
  hint?: ReactNode
  type?: string
  placeholder?: string
  upper?: boolean
  wide?: boolean
  maxLength?: number
  inputMode?: 'numeric' | 'decimal' | 'email' | 'tel'
}) {
  return (
    <Field label={label} required={required} hint={hint} error={shown(p, k)} wide={wide}>
      <input
        type={type}
        value={p.d[k] as string}
        placeholder={placeholder}
        maxLength={maxLength}
        inputMode={inputMode}
        aria-invalid={!!shown(p, k)}
        onChange={(e) => p.set({ [k]: upper ? e.target.value.toUpperCase() : e.target.value } as Partial<HireDraft>)}
      />
    </Field>
  )
}

function Choice({
  p, k, label, options, empty, hint, required,
}: {
  p: StepProps
  k: keyof HireDraft
  label: string
  options: Array<{ value: string; label: string }>
  empty?: string
  hint?: ReactNode
  required?: boolean
}) {
  return (
    <Field label={label} hint={hint} error={shown(p, k)} required={required}>
      <select
        value={p.d[k] as string}
        onChange={(e) => p.set({ [k]: e.target.value } as Partial<HireDraft>)}
      >
        {empty !== undefined && <option value="">{empty}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  )
}

function Toggle({
  checked, onChange, label, desc,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  desc?: string
}) {
  return (
    <label className="hire-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="hire-switch" aria-hidden />
      <span className="hire-toggle-body">
        <span className="hire-toggle-label">{label}</span>
        {desc && <span className="hire-toggle-desc">{desc}</span>}
      </span>
    </label>
  )
}

function Locked({ children }: { children: ReactNode }) {
  return <div className="hire-locked">{children}</div>
}

/* ----------------------------------------------------------------- steps --- */

export function BasicStep(p: StepProps) {
  return (
    <>
      <Section title="Name" desc="As it appears on their government ID — letters and payslips print it.">
        <Text p={p} k="first_name" label="First name" required />
        <Text p={p} k="middle_name" label="Middle name" />
        <Text p={p} k="last_name" label="Last name" />
      </Section>
      <Section title="Work contact">
        <Text p={p} k="email" label="Work email" required type="email" inputMode="email"
              placeholder="name@company.com" hint="Their sign-in, and where notifications go." />
        <Text p={p} k="phone" label="Mobile number" inputMode="tel" placeholder="+91 98765 43210" />
      </Section>
      <Section title="Joining">
        <Text p={p} k="employee_code" label="Employee ID"
              hint="The next ID from HR Settings → General. Change it, or clear it to have one issued automatically." />
        <Text p={p} k="joined_on" label="Date of joining" type="date" required />
        <Choice p={p} k="status" label="Status" options={[
          { value: 'active', label: 'Active — already working' },
          { value: 'pending_setup', label: 'Pre-joining — starts later' },
        ]} hint={p.d.status === 'pending_setup'
          ? 'They appear in onboarding, not in attendance, until they join.'
          : undefined} />
        <Text p={p} k="timezone" label="Time zone" placeholder="Asia/Kolkata"
              hint="Attendance days and reports are cut in this zone." />
      </Section>
    </>
  )
}

export function PersonalStep(p: StepProps) {
  if (!p.can.people) {
    return <Locked>You need the “See and edit HR records” permission to record personal details. The employee can fill these in themselves from My Profile.</Locked>
  }
  return (
    <>
      <Section title="Personal information">
        <Text p={p} k="date_of_birth" label="Date of birth" type="date" />
        <Choice p={p} k="gender" label="Gender" empty="Select" options={[
          { value: 'female', label: 'Female' }, { value: 'male', label: 'Male' },
          { value: 'other', label: 'Other' }, { value: 'undisclosed', label: 'Prefer not to say' },
        ]} />
        <Choice p={p} k="marital_status" label="Marital status" empty="Select" options={[
          { value: 'single', label: 'Single' }, { value: 'married', label: 'Married' },
          { value: 'divorced', label: 'Divorced' }, { value: 'widowed', label: 'Widowed' },
        ]} />
        <Choice p={p} k="blood_group" label="Blood group" empty="Select"
                options={BLOOD_GROUPS.map((b) => ({ value: b, label: b }))} />
        <Text p={p} k="nationality" label="Nationality" />
        <Text p={p} k="father_name" label="Father’s / spouse’s name"
              hint="PF nomination and Form 11 ask for it." />
      </Section>
      <Section title="Personal contact" desc="Kept apart from work email — it still works after they leave, when payroll needs to send their Form 16.">
        <Text p={p} k="personal_email" label="Personal email" type="email" inputMode="email" />
        <Text p={p} k="alternate_phone" label="Alternate phone" inputMode="tel" />
      </Section>
      <Section title="Emergency contact">
        <Text p={p} k="emergency_name" label="Contact name" />
        <Choice p={p} k="emergency_relationship" label="Relationship" empty="Select"
                options={RELATIONSHIPS.map((r) => ({ value: r, label: r }))} />
        <Text p={p} k="emergency_phone" label="Contact phone" inputMode="tel" />
      </Section>
    </>
  )
}

function AddressBlock({ p, prefix }: { p: StepProps; prefix: 'current' | 'permanent' }) {
  const k = (s: string) => `${prefix}_${s}` as keyof HireDraft
  return (
    <>
      <Field label="Address" wide error={shown(p, k('address'))}>
        <textarea rows={2} value={p.d[k('address')] as string}
                  placeholder="House / flat, street, locality"
                  onChange={(e) => p.set({ [k('address')]: e.target.value } as Partial<HireDraft>)} />
      </Field>
      <Text p={p} k={k('city')} label="City" />
      <Text p={p} k={k('state')} label="State" />
      <Text p={p} k={k('postal_code')} label="PIN / postal code" />
      <Text p={p} k={k('country')} label="Country code" upper maxLength={2} placeholder="IN" />
    </>
  )
}

export function AddressStep(p: StepProps) {
  if (!p.can.people) {
    return <Locked>Addresses are part of the HR record. You need the “See and edit HR records” permission.</Locked>
  }
  return (
    <>
      <Section title="Current address"><AddressBlock p={p} prefix="current" /></Section>
      <section className="hire-section">
        <Toggle
          checked={p.d.permanent_same}
          onChange={(v) => p.set({ permanent_same: v })}
          label="Permanent address is the same as current"
        />
      </section>
      {!p.d.permanent_same && (
        <Section title="Permanent address"><AddressBlock p={p} prefix="permanent" /></Section>
      )}
    </>
  )
}

export function JobStep(p: StepProps) {
  const { lk, d } = p
  const probationEnd = d.joined_on && /^\d+$/.test(d.probation_months) && Number(d.probation_months) > 0
    ? addMonths(d.joined_on, Number(d.probation_months))
    : null
  const teams = d.department_id
    ? lk.teams.filter((t) => !t.department_id || t.department_id === d.department_id)
    : lk.teams
  return (
    <>
      <Section title="Position in the organisation">
        <Choice p={p} k="department_id" label="Department" empty="Unassigned"
                options={lk.departments.filter((x) => x.is_active).map((x) => ({ value: x.id, label: x.name }))}
                hint={lk.departments.length ? undefined : 'No departments yet — add them under Department & Designation.'} />
        <Choice p={p} k="designation_id" label="Designation" empty="Unassigned"
                options={lk.designations.filter((x) => x.is_active).map((x) => ({ value: x.id, label: x.name }))} />
        <Choice p={p} k="team_id" label="Team" empty="Unassigned"
                options={teams.filter((t) => t.is_active).map((t) => ({ value: t.id, label: t.name }))} />
        <Choice p={p} k="manager_id" label="Reporting manager" empty="Nobody — top level"
                options={lk.people.filter((x) => x.is_active).map((x) => ({
                  value: x.id,
                  label: x.designation_name ? `${x.full_name} · ${x.designation_name}` : x.full_name,
                }))}
                hint="Approvals route to them, and they see this person’s attendance and leave." />
      </Section>
      {p.can.people ? (
        <Section title="Employment terms">
          <Choice p={p} k="employment_type" label="Employment type" options={EMPLOYMENT_TYPES} />
          <Text p={p} k="work_location" label="Work location" placeholder="Mumbai HQ" />
          <Text p={p} k="grade" label="Grade / band" placeholder="L3" />
          <Text p={p} k="probation_months" label="Probation (months)" inputMode="numeric"
                hint={probationEnd ? `Probation ends ${new Date(probationEnd).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}.` : '0 if they join confirmed.'} />
          <Text p={p} k="notice_period_days" label="Notice period (days)" inputMode="numeric"
                hint="Used by full & final settlement to recover short notice." />
          <Choice p={p} k="bgv_status" label="Background verification" empty="Not started" options={BGV_STATUSES} />
        </Section>
      ) : (
        <Locked>Employment terms (type, probation, notice) need the “See and edit HR records” permission.</Locked>
      )}
    </>
  )
}

export function AttendanceStep(p: StepProps) {
  const { d, lk } = p
  const shift = lk.shifts.find((s) => s.id === d.shift_id)
  return (
    <>
      <section className="hire-section">
        <header className="hire-section-head">
          <h3>Attendance type</h3>
          <p>How this person is expected to mark attendance. It decides which geofence rule applies to their punches.</p>
        </header>
        <div className="hire-cards" role="radiogroup" aria-label="Attendance type">
          {ATTENDANCE_TYPES.map((t) => (
            <button
              type="button"
              key={t.value}
              role="radio"
              aria-checked={d.attendance_type === t.value}
              className={`hire-card${d.attendance_type === t.value ? ' is-on' : ''}`}
              onClick={() => p.set({
                attendance_type: t.value,
                // Field staff are who "punch from anywhere" exists for; switch it
                // on with the card, and off again if they move away from it.
                can_punch_anywhere: t.value === 'field' ? true
                  : d.attendance_type === 'field' ? false : d.can_punch_anywhere,
              })}
            >
              <span className="hire-card-radio" aria-hidden />
              <span className="hire-card-title">{t.label}</span>
              <span className="hire-card-desc">{t.desc}</span>
            </button>
          ))}
        </div>
      </section>
      <Section title="Shift and schedule">
        <Choice p={p} k="shift_id" label="Shift" empty="No shift — use the work schedule"
                options={lk.shifts.filter((s) => s.is_active).map((s) => ({
                  value: s.id,
                  label: `${s.name} (${s.start_time}–${s.end_time}${s.is_night_shift ? ', night' : ''})`,
                }))}
                hint={shift
                  ? `Effective from the joining date. Late marks count from ${shift.start_time}.`
                  : lk.shifts.length ? undefined : 'No shifts defined yet — add them in Attendance settings.'} />
        <Choice p={p} k="schedule_id" label="Work schedule" empty="Company default"
                options={lk.schedules.map((s) => ({ value: s.id, label: `${s.name} (${s.start_time}–${s.end_time})` }))}
                hint="Working days and break time, used for expected hours." />
      </Section>
      <section className="hire-section">
        <Toggle
          checked={d.can_punch_anywhere}
          onChange={(v) => p.set({ can_punch_anywhere: v })}
          label="Allow punching from anywhere"
          desc="Exempt from the geofence. The punch is still recorded with its location and distance, so they are not unmeasured."
        />
      </section>
    </>
  )
}

export function PayStep(p: StepProps) {
  const { d, lk, can } = p
  const earnings = useMemo(() => lk.components.filter((c) => c.kind === 'earning' && c.is_active), [lk.components])
  const gross = toPaise(d.gross_monthly)
  return (
    <>
      {can.payroll && earnings.length === 0 ? (
        <Locked>
          No pay components are defined yet, so a salary cannot be set here. Set them up in
          Payroll → Pay components, then add this person’s salary from Payroll → Salary structures.
        </Locked>
      ) : can.payroll ? (
        <section className="hire-section">
          <header className="hire-section-head">
            <h3>Salary</h3>
            <p>The joining salary structure. Leave blank to set it later in Payroll → Salary structures.</p>
          </header>
          <div className="hire-grid">
            <Field label="Monthly gross (₹)" error={shown(p, 'gross_monthly')}
                   hint={gross ? `${money(gross * 12)} a year.` : undefined}>
              <input value={d.gross_monthly} inputMode="decimal" placeholder="50,000"
                     onChange={(e) => p.set({
                       gross_monthly: e.target.value,
                       // Pick every earning the first time a figure is typed —
                       // the common case is "the standard structure".
                       salary_components: d.salary_components.length || !e.target.value
                         ? d.salary_components : earnings.map((c) => c.id),
                     })} />
            </Field>
            <Field label="Effective from" hint="Defaults to the joining date.">
              <input type="date" value={d.salary_from || d.joined_on}
                     onChange={(e) => p.set({ salary_from: e.target.value })} />
            </Field>
          </div>
          {d.gross_monthly && (
            earnings.length ? (
              <div className="hire-components">
                {earnings.map((c) => {
                  const on = d.salary_components.includes(c.id)
                  return (
                    <div className={`hire-component${on ? ' is-on' : ''}`} key={c.id}>
                      <label className="hire-component-pick">
                        <input type="checkbox" checked={on} onChange={() => p.set({
                          salary_components: on
                            ? d.salary_components.filter((x) => x !== c.id)
                            : [...d.salary_components, c.id],
                        })} />
                        <span>
                          <span className="hire-component-name">{c.name}</span>
                          <span className="hire-component-rule">
                            {c.calculation === 'fixed' ? 'Fixed amount'
                              : c.calculation === 'balance' ? 'Balance of gross'
                                : `${(c.rate_bps / 100).toFixed(2).replace(/\.00$/, '')}% of ${c.calculation === 'percent_of_basic' ? 'basic' : 'gross'}`}
                          </span>
                        </span>
                      </label>
                      {on && c.calculation === 'fixed' && (
                        <input className="hire-component-amount" inputMode="decimal" placeholder="₹ per month"
                               value={d.fixed_amounts[c.id] ?? ''}
                               onChange={(e) => p.set({ fixed_amounts: { ...d.fixed_amounts, [c.id]: e.target.value } })} />
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              <Locked>No pay components are defined yet. Set them up in Payroll → Pay components first.</Locked>
            )
          )}
        </section>
      ) : (
        <Locked>Salary needs the “See and set salaries” permission. Someone in payroll can add it afterwards.</Locked>
      )}

      {can.people && (
        <>
          <Section title="Statutory" desc="Encrypted at rest and masked everywhere. Revealing one later is a separate, audited action.">
            <Text p={p} k="pan" label="PAN" upper maxLength={10} placeholder="ABCDE1234F" />
            <Text p={p} k="aadhaar" label="Aadhaar" inputMode="numeric" maxLength={14} placeholder="12 digits" />
            <Text p={p} k="uan" label="UAN" inputMode="numeric" maxLength={12} hint="If they had PF at a previous employer." />
            <Text p={p} k="pf_number" label="PF number" />
            <Text p={p} k="esi_number" label="ESI number" />
          </Section>
          <Section title="Bank account" desc="Where salary is paid.">
            <Text p={p} k="bank_account_name" label="Account holder name"
                  placeholder={fullName(d) || undefined} />
            <Text p={p} k="bank_account" label="Account number" inputMode="numeric" type="password" />
            <Text p={p} k="bank_account_confirm" label="Confirm account number" inputMode="numeric" />
            <Text p={p} k="bank_ifsc" label="IFSC" upper maxLength={11} placeholder="HDFC0001234" />
            <Text p={p} k="bank_name" label="Bank name" />
            <Text p={p} k="bank_branch" label="Branch" />
          </Section>
        </>
      )}
    </>
  )
}

export function AssetsStep(p: StepProps) {
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  if (!p.can.assets) {
    return <Locked>Issuing assets needs the “Manage the asset register” permission.</Locked>
  }
  const available = p.lk.assets.filter((a) => a.status === 'available')
  const categories = [...new Set(available.map((a) => a.category))].sort()
  const needle = q.trim().toLowerCase()
  const rows = available.filter((a) =>
    (!category || a.category === category) &&
    (!needle || [a.asset_tag, a.name, a.brand, a.model_name, a.serial_number]
      .some((v) => (v ?? '').toLowerCase().includes(needle))))
  const picked = p.d.asset_ids
  const toggle = (id: string) => p.set({
    asset_ids: picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id],
  })
  return (
    <section className="hire-section">
      <header className="hire-section-head">
        <h3>Issue company assets</h3>
        <p>Only items currently in stock are listed. Each one is handed over the moment the employee is created.</p>
      </header>
      {available.length === 0 ? (
        <Locked>No assets are in stock. Add them to the asset register, or issue them later.</Locked>
      ) : (
        <>
          <div className="hire-toolbar">
            <input type="search" placeholder="Search tag, name, serial…" value={q}
                   onChange={(e) => setQ(e.target.value)} aria-label="Search assets" />
            <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
              <option value="">All categories</option>
              {categories.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
            </select>
            <span className="hire-count">{picked.length} selected</span>
          </div>
          <div className="hire-asset-list">
            {rows.map((a) => {
              const on = picked.includes(a.id)
              return (
                <label key={a.id} className={`hire-asset${on ? ' is-on' : ''}`}>
                  <input type="checkbox" checked={on} onChange={() => toggle(a.id)} />
                  <span className="hire-asset-tag">{a.asset_tag}</span>
                  <span className="hire-asset-name">
                    {a.name || [a.brand, a.model_name].filter(Boolean).join(' ') || a.category}
                    <span className="hire-asset-meta">
                      {a.category.replace(/_/g, ' ')}{a.serial_number ? ` · SN ${a.serial_number}` : ''}
                      {a.location ? ` · ${a.location}` : ''}
                    </span>
                  </span>
                </label>
              )
            })}
            {rows.length === 0 && <div className="hire-empty">Nothing matches.</div>}
          </div>
          {picked.length > 0 && (
            <div className="hire-grid" style={{ marginTop: 16 }}>
              <Field label="Handover note" wide hint="Recorded against each assignment — condition, accessories included.">
                <input value={p.d.asset_note} placeholder="New, with charger and bag"
                       onChange={(e) => p.set({ asset_note: e.target.value })} />
              </Field>
            </div>
          )}
        </>
      )}
    </section>
  )
}

export function DocumentsStep(p: StepProps) {
  if (!p.can.people) {
    return <Locked>Uploading documents to someone else’s record needs the “See and edit HR records” permission.</Locked>
  }
  const docs = p.d.documents
  const update = (key: string, patch: Partial<HireDraft['documents'][number]>) =>
    p.set({ documents: docs.map((x) => (x.key === key ? { ...x, ...patch } : x)) })
  const add = (doc_type = 'offer_letter') => p.set({
    documents: [...docs, {
      key: Math.random().toString(36).slice(2), doc_type, title: '', issued_on: '', expires_on: '', file: null,
    }],
  })
  const quick = ['offer_letter', 'pan_card', 'aadhaar_card', 'education', 'experience_letter', 'bank_proof']
  return (
    <section className="hire-section">
      <header className="hire-section-head">
        <h3>Documents</h3>
        <p>PDF or image, up to 10 MB each. They land in the employee’s HR record, unverified until someone checks them.</p>
      </header>
      <div className="hire-chips">
        {quick.map((t) => (
          <button type="button" key={t} className="hire-chip" onClick={() => add(t)}>
            + {DOC_TYPES.find((x) => x.value === t)?.label}
          </button>
        ))}
      </div>
      {docs.length === 0 ? (
        <div className="hire-dropzone">
          <p>No documents added. Use a shortcut above, or</p>
          <button type="button" className="btn" onClick={() => add('other')}>Add a document</button>
        </div>
      ) : (
        <div className="hire-docs">
          {docs.map((doc) => {
            const err = shown(p, `doc_${doc.key}`)
            return (
              <div className={`hire-doc${err ? ' has-error' : ''}`} key={doc.key}>
                <select value={doc.doc_type} onChange={(e) => update(doc.key, { doc_type: e.target.value })}
                        aria-label="Document type">
                  {DOC_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <input placeholder="Title (optional)" value={doc.title}
                       onChange={(e) => update(doc.key, { title: e.target.value })} aria-label="Title" />
                <label className="hire-file">
                  <input type="file" accept=".pdf,image/*"
                         onChange={(e) => update(doc.key, { file: e.target.files?.[0] ?? null })} />
                  <span>{doc.file ? doc.file.name : 'Choose file…'}</span>
                </label>
                <input type="date" value={doc.issued_on} aria-label="Issued on" title="Issued on"
                       onChange={(e) => update(doc.key, { issued_on: e.target.value })} />
                <input type="date" value={doc.expires_on} aria-label="Expires on" title="Expires on"
                       onChange={(e) => update(doc.key, { expires_on: e.target.value })} />
                <button type="button" className="btn btn-sm btn-ghost" aria-label="Remove document"
                        onClick={() => p.set({ documents: docs.filter((x) => x.key !== doc.key) })}>
                  Remove
                </button>
                {err && <span className="hire-error hire-doc-error">{err}</span>}
              </div>
            )
          })}
          <button type="button" className="btn btn-sm" onClick={() => add('other')}>+ Add another</button>
        </div>
      )}
    </section>
  )
}

export function AccessStep(p: StepProps) {
  const { d, lk } = p
  const [advanced, setAdvanced] = useState(false)
  const roles = lk.roles.filter((r) => r.base_role !== 'owner')
  const chosen = roles.find((r) => r.id === d.role_id)
  const scope: Record<string, string> = {
    self: 'Only their own records', team: 'Their reporting line',
    department: 'Their whole department', company: 'The whole company',
  }
  const isEmployee = d.role === 'employee'
  return (
    <>
      <section className="hire-section">
        <header className="hire-section-head">
          <h3>Role</h3>
          <p>Decides what they see and what they can approve. Roles are defined under Employee → Role & Permission.</p>
        </header>
        <div className="hire-cards hire-cards-roles" role="radiogroup" aria-label="Role">
          {roles.map((r) => {
            const count = Object.values(r.permissions).filter(Boolean).length
            return (
              <button type="button" key={r.id} role="radio" aria-checked={d.role_id === r.id}
                      className={`hire-card${d.role_id === r.id ? ' is-on' : ''}`}
                      onClick={() => p.set({ role_id: r.id, role: r.base_role })}>
                <span className="hire-card-radio" aria-hidden />
                <span className="hire-card-title">{r.name}</span>
                <span className="hire-card-desc">
                  {r.description || `${scope[r.data_scope] ?? r.data_scope}.`}
                </span>
                <span className="hire-card-meta">
                  {scope[r.data_scope] ?? r.data_scope} · {count} permission{count === 1 ? '' : 's'}
                </span>
              </button>
            )
          })}
        </div>
        {p.touched && p.errors.role_id && <span className="hire-error">{p.errors.role_id}</span>}
      </section>

      <section className="hire-section">
        <header className="hire-section-head"><h3>Sign-in</h3></header>
        <Toggle
          checked={d.console_access}
          onChange={(v) => p.set({ console_access: v, password: v ? d.password : '' })}
          label="Can sign in to the web console"
          desc="Off for staff who only run the desktop agent — they use their enrollment key and never sign in."
        />
        {d.console_access && (
          <div className="hire-grid" style={{ marginTop: 14 }}>
            <Field label="Initial password" error={shown(p, 'password')}
                   hint="At least 8 characters. Share it privately — they can change it later.">
              <div className="hire-inline">
                <input type="text" value={d.password} autoComplete="new-password"
                       onChange={(e) => p.set({ password: e.target.value })} />
                <button type="button" className="btn btn-sm" onClick={() => p.set({ password: generatePassword() })}>
                  Generate
                </button>
              </div>
            </Field>
          </div>
        )}
      </section>

      <section className="hire-section">
        <button type="button" className="hire-disclosure" aria-expanded={advanced}
                onClick={() => setAdvanced((v) => !v)}>
          <span>{advanced ? '▾' : '▸'}</span> Per-person restrictions
          <span className="hire-disclosure-note">
            {chosen ? `Narrow what “${chosen.name}” allows, for this person only.` : 'Optional.'}
          </span>
        </button>
        {advanced && (
          <>
            {isEmployee && (
              <p className="hire-hint" style={{ margin: '10px 0' }}>
                At employee level they only ever see their own work, so most of these make no difference.
              </p>
            )}
            <div className="perm-grid">
              {PERMISSIONS.filter((x) => x.key !== 'can_punch_anywhere').map((x) => (
                <label className="perm-row" key={x.key}>
                  <input type="checkbox" checked={d.permissions[x.key]}
                         disabled={isEmployee && !('selfScoped' in x && x.selfScoped)}
                         onChange={(e) => p.set({ permissions: { ...d.permissions, [x.key]: e.target.checked } })} />
                  <span className="perm-body">
                    <span className="perm-label">{x.label}</span>
                    <span className="perm-desc">{x.description}</span>
                  </span>
                </label>
              ))}
            </div>
            <h4 className="hire-subhead">Pages they can open</h4>
            <div className="page-chips">
              {PAGES.map((pg) => {
                const on = !d.hidden_pages.includes(pg.key)
                return (
                  <button type="button" key={pg.key} aria-pressed={on}
                          className={`page-chip${on ? ' page-chip-on' : ''}`}
                          onClick={() => p.set({
                            hidden_pages: on ? [...d.hidden_pages, pg.key] : d.hidden_pages.filter((k) => k !== pg.key),
                          })}>
                    {pg.label}
                  </button>
                )
              })}
            </div>
          </>
        )}
      </section>
    </>
  )
}

function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const bytes = new Uint32Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

/* ---------------------------------------------------------------- review --- */

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="hire-review-row">
      <dt>{label}</dt>
      <dd>{value || <span className="hire-dim">—</span>}</dd>
    </div>
  )
}

function ReviewCard({ title, step, goTo, errors, children }: {
  title: string; step: StepId; goTo: (s: StepId) => void; errors: number; children: ReactNode
}) {
  return (
    <section className={`hire-review-card${errors ? ' has-error' : ''}`}>
      <header>
        <h4>{title}</h4>
        {errors > 0 && <span className="hire-badge-bad">{errors} to fix</span>}
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => goTo(step)}>Edit</button>
      </header>
      <dl>{children}</dl>
    </section>
  )
}

const fmt = (iso: string) =>
  iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''

export function ReviewStep(p: StepProps & { allErrors: Record<StepId, Errors> }) {
  const { d, lk, can, goTo, allErrors } = p
  const name = (list: Array<{ id: string; name?: string; full_name?: string }>, id: string) => {
    const x = list.find((r) => r.id === id)
    return x ? (x.name ?? x.full_name ?? '') : ''
  }
  const label = (opts: Array<{ value: string; label: string }>, v: string) => opts.find((o) => o.value === v)?.label ?? v
  const n = (s: StepId) => Object.keys(allErrors[s]).length
  const gross = toPaise(d.gross_monthly)
  const templates = lk.templates.filter((t) => t.is_active !== false)
  return (
    <>
      <div className="hire-review-grid">
        <ReviewCard title="Basic details" step="basic" goTo={goTo} errors={n('basic')}>
          <Row label="Name" value={fullName(d)} />
          <Row label="Work email" value={d.email} />
          <Row label="Mobile" value={d.phone} />
          <Row label="Employee ID" value={d.employee_code} />
          <Row label="Joining" value={fmt(d.joined_on)} />
          <Row label="Status" value={d.status === 'active' ? 'Active' : 'Pre-joining'} />
        </ReviewCard>
        <ReviewCard title="Employment" step="job" goTo={goTo} errors={n('job')}>
          <Row label="Department" value={name(lk.departments, d.department_id)} />
          <Row label="Designation" value={name(lk.designations, d.designation_id)} />
          <Row label="Team" value={name(lk.teams, d.team_id)} />
          <Row label="Reports to" value={name(lk.people, d.manager_id)} />
          <Row label="Type" value={label(EMPLOYMENT_TYPES, d.employment_type)} />
          <Row label="Probation" value={d.probation_months && d.probation_months !== '0' ? `${d.probation_months} months` : 'None'} />
          <Row label="Notice" value={d.notice_period_days ? `${d.notice_period_days} days` : ''} />
        </ReviewCard>
        <ReviewCard title="Attendance" step="attendance" goTo={goTo} errors={n('attendance')}>
          <Row label="Type" value={label(ATTENDANCE_TYPES, d.attendance_type)} />
          <Row label="Shift" value={name(lk.shifts, d.shift_id)} />
          <Row label="Schedule" value={name(lk.schedules, d.schedule_id) || 'Company default'} />
          <Row label="Punch anywhere" value={d.can_punch_anywhere ? 'Yes' : 'No'} />
        </ReviewCard>
        <ReviewCard title="Personal & address" step="personal" goTo={goTo} errors={n('personal') + n('address')}>
          <Row label="Date of birth" value={fmt(d.date_of_birth)} />
          <Row label="Gender" value={d.gender === 'undisclosed' ? 'Prefer not to say' : d.gender.charAt(0).toUpperCase() + d.gender.slice(1)} />
          <Row label="Personal email" value={d.personal_email} />
          <Row label="Emergency" value={d.emergency_name ? `${d.emergency_name}${d.emergency_phone ? ` · ${d.emergency_phone}` : ''}` : ''} />
          <Row label="City" value={[d.current_city, d.current_state].filter(Boolean).join(', ')} />
        </ReviewCard>
        <ReviewCard title="Salary & statutory" step="pay" goTo={goTo} errors={n('pay')}>
          <Row label="Monthly gross" value={can.payroll && gross ? money(gross) : can.payroll ? 'Set later' : 'No permission'} />
          <Row label="PAN" value={d.pan ? `••••••${d.pan.slice(-4)}` : ''} />
          <Row label="Aadhaar" value={d.aadhaar ? `•••• ${d.aadhaar.replace(/\s/g, '').slice(-4)}` : ''} />
          <Row label="Bank" value={d.bank_account ? `${d.bank_name || d.bank_ifsc} ••${d.bank_account.slice(-4)}` : ''} />
        </ReviewCard>
        <ReviewCard title="Access, assets & documents" step="access" goTo={goTo} errors={n('access') + n('documents')}>
          <Row label="Role" value={name(lk.roles, d.role_id)} />
          <Row label="Console sign-in" value={d.console_access ? (d.password ? 'Yes, password set' : 'Yes — set a password later') : 'Agent only'} />
          <Row label="Assets" value={d.asset_ids.length ? `${d.asset_ids.length} to issue` : ''} />
          <Row label="Documents" value={d.documents.length ? `${d.documents.length} to upload` : ''} />
        </ReviewCard>
      </div>

      {can.onboarding && (
        <section className="hire-section">
          <Toggle
            checked={d.start_onboarding}
            onChange={(v) => p.set({ start_onboarding: v })}
            label="Start an onboarding checklist"
            desc="IT setup, induction, document collection — tracked under Onboarding with owners and due dates."
          />
          {d.start_onboarding && (
            <div className="hire-grid" style={{ marginTop: 14 }}>
              <Field label="Checklist template" hint="Automatic picks the template set up for their department.">
                <select value={d.onboarding_template_id}
                        onChange={(e) => p.set({ onboarding_template_id: e.target.value })}>
                  <option value="">Automatic</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
            </div>
          )}
        </section>
      )}
    </>
  )
}
