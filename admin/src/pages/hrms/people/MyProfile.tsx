/* The employee master record — one person, four sections.

   Reused for both "my profile" and "somebody else's", because they are the same
   record with different permissions, and two components would be two places to
   forget a field. What differs is decided by the server: `can_edit_personal`,
   `can_edit_employment` and `can_reveal` arrive on the payload and this file
   renders from them rather than re-deriving the rule from a role. The UI's copy
   of a permission rule is the one nobody writes a test for.

   Three server truths this file is built around:

   1. **Statutory numbers arrive masked and never in full.** `pan_masked`,
      `aadhaar_masked`, `bank_account_masked`. Revealing one is a POST that
      writes an audit row, so the reveal is a button a person presses — never
      something the page does on load to "save a click". `has_pan` exists so the
      form can tell "on file, masked" from "nobody entered one".

   2. **The two halves are two endpoints.** Personal details PATCH `/{id}`;
      employment PATCHes `/{id}/employment` and confirmation POSTs to its own
      route. Submitting them together would need one request model that accepts
      both, which is the escalation the server split apart.

   3. **A PATCH is a patch.** Each section submits only its own fields, because
      the server honours `exclude_unset` — sending the whole object back would
      have the personal form overwrite whatever the employment form just set. */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { ErrorNote, Loading } from '../../../components/ui'
import type { EmployeeProfile } from '../../../lib/types'
import EmployeeDocuments from './EmployeeDocuments'
import '../../../styles/people.css'

const GENDERS = ['female', 'male', 'other', 'undisclosed'] as const
const MARITAL = ['single', 'married', 'divorced', 'widowed', 'other'] as const
const EMPLOYMENT = ['full_time', 'part_time', 'contract', 'intern', 'consultant'] as const
const CONFIRMATION = ['not_applicable', 'probation', 'confirmed', 'extended', 'terminated'] as const

function title(value: string | null | undefined): string {
  if (!value) return '—'
  return value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

export default function MyProfile({ userId }: { userId?: string }) {
  const path = userId ? `/people/${userId}` : '/people/me'
  const profileQ = useQuery<EmployeeProfile>(`profile-${userId ?? 'me'}`, () =>
    api.get<EmployeeProfile>(path),
  )

  if (profileQ.loading) return <Loading />
  if (profileQ.error) return <ErrorNote>{profileQ.error}</ErrorNote>
  if (!profileQ.data) return null

  return (
    <ProfileBody profile={profileQ.data} onSaved={profileQ.reload} />
  )
}

function ProfileBody({
  profile,
  onSaved,
}: {
  profile: EmployeeProfile
  onSaved: () => void
}) {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{profile.full_name}</h1>
          <p className="muted">
            {[profile.designation, profile.department, profile.employee_code]
              .filter(Boolean)
              .join(' · ') || profile.email}
          </p>
        </div>
        <ConfirmationPill profile={profile} />
      </header>

      <div className="hr-profile-grid">
        <PersonalSection profile={profile} onSaved={onSaved} />
        <StatutorySection profile={profile} onSaved={onSaved} />
        <EmploymentSection profile={profile} onSaved={onSaved} />
        <EmployeeDocuments userId={profile.user_id} canManage={profile.can_edit_employment} />
      </div>

      {profile.updated_by_name && (
        <p className="muted hr-profile-foot">
          Last updated by {profile.updated_by_name}
          {profile.updated_at ? ` on ${profile.updated_at.slice(0, 10)}` : ''}
        </p>
      )}
    </div>
  )
}

function ConfirmationPill({ profile }: { profile: EmployeeProfile }) {
  const tone =
    profile.confirmation_status === 'confirmed'
      ? 'ok'
      : profile.confirmation_status === 'terminated'
        ? 'bad'
        : profile.confirmation_status === 'not_applicable'
          ? 'muted'
          : 'warn'
  return (
    <div className={`hr-pill hr-pill-${tone}`}>
      {title(profile.confirmation_status)}
      {profile.confirmation_status === 'confirmed' && profile.confirmed_on
        ? ` · ${profile.confirmed_on}`
        : profile.probation_end_on && profile.confirmation_status !== 'confirmed'
          ? ` · ends ${profile.probation_end_on}`
          : ''}
    </div>
  )
}

/* --- a small form harness, shared by the three sections ------------------- */

/** Employment fields the server types as `int | None`. See the submit below. */
const NUMERIC_EMPLOYMENT_FIELDS = new Set(['probation_months', 'notice_period_days'])

function useSection<T extends object>(initial: T, submit: (body: Partial<T>) => Promise<unknown>) {
  const [draft, setDraft] = useState<T>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Re-seed when the server's copy changes (after a save elsewhere on the
  // page), but not while the user is mid-edit — hence the dependency on the
  // serialised initial rather than on the object identity, which changes on
  // every render of the parent.
  const seed = JSON.stringify(initial)
  useEffect(() => {
    setDraft(JSON.parse(seed) as T)
  }, [seed])

  const dirty = useMemo(() => JSON.stringify(draft) !== seed, [draft, seed])

  function set<K extends keyof T>(key: K, value: T[K]) {
    setSaved(false)
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  async function save() {
    setBusy(true)
    setError(null)
    try {
      // Only the changed keys. The server honours exclude_unset, so sending the
      // whole object would have this section overwrite fields it does not own.
      const changed: Partial<T> = {}
      const base = JSON.parse(seed) as T
      for (const key of Object.keys(draft) as (keyof T)[]) {
        if (draft[key] !== base[key]) changed[key] = draft[key]
      }
      await submit(changed)
      setSaved(true)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return { draft, set, save, dirty, busy, error, saved }
}

function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: React.ReactNode
  hint?: string
}) {
  return (
    <label className="hr-field">
      <span className="hr-field-label">{label}</span>
      {children}
      {hint && <span className="hr-field-hint">{hint}</span>}
    </label>
  )
}

function SectionShell({
  heading,
  editable,
  state,
  children,
}: {
  heading: string
  editable: boolean
  state: ReturnType<typeof useSection<never>> | ReturnType<typeof useSection<any>>
  children: React.ReactNode
}) {
  return (
    <section className="card hr-section">
      <h2 className="card-title">{heading}</h2>
      {state.error && <ErrorNote>{state.error}</ErrorNote>}
      <div className="hr-field-grid">{children}</div>
      {editable && (
        <div className="hr-section-actions">
          <button className="btn primary" onClick={state.save} disabled={!state.dirty || state.busy}>
            {state.busy ? 'Saving…' : 'Save'}
          </button>
          {state.saved && !state.dirty && <span className="ok-note">Saved</span>}
        </div>
      )}
    </section>
  )
}

/* --- personal -------------------------------------------------------------- */

function PersonalSection({
  profile,
  onSaved,
}: {
  profile: EmployeeProfile
  onSaved: () => void
}) {
  const editable = profile.can_edit_personal
  const state = useSection(
    {
      date_of_birth: profile.date_of_birth ?? '',
      gender: profile.gender ?? '',
      marital_status: profile.marital_status ?? '',
      blood_group: profile.blood_group ?? '',
      nationality: profile.nationality ?? '',
      personal_email: profile.personal_email ?? '',
      alternate_phone: profile.alternate_phone ?? '',
      current_address: profile.current_address ?? '',
      current_city: profile.current_city ?? '',
      current_state: profile.current_state ?? '',
      current_postal_code: profile.current_postal_code ?? '',
      permanent_address: profile.permanent_address ?? '',
      permanent_city: profile.permanent_city ?? '',
      permanent_state: profile.permanent_state ?? '',
      permanent_postal_code: profile.permanent_postal_code ?? '',
      emergency_name: profile.emergency_name ?? '',
      emergency_relationship: profile.emergency_relationship ?? '',
      emergency_phone: profile.emergency_phone ?? '',
    },
    async (body) => {
      // '' is how a cleared input arrives; the server trims it to null, which is
      // what "cleared on purpose" has to mean. Sending undefined instead would
      // leave the old value in place and the field would silently refuse to
      // empty.
      await api.patch(`/people/${profile.user_id}`, body)
      onSaved()
    },
  )

  const ro = !editable
  return (
    <SectionShell heading="Personal details" editable={editable} state={state}>
      <Field label="Date of birth">
        <input type="date" value={state.draft.date_of_birth} disabled={ro}
               onChange={(e) => state.set('date_of_birth', e.target.value)} />
      </Field>
      <Field label="Gender">
        <select value={state.draft.gender} disabled={ro}
                onChange={(e) => state.set('gender', e.target.value)}>
          <option value="">—</option>
          {GENDERS.map((g) => <option key={g} value={g}>{title(g)}</option>)}
        </select>
      </Field>
      <Field label="Marital status">
        <select value={state.draft.marital_status} disabled={ro}
                onChange={(e) => state.set('marital_status', e.target.value)}>
          <option value="">—</option>
          {MARITAL.map((m) => <option key={m} value={m}>{title(m)}</option>)}
        </select>
      </Field>
      <Field label="Blood group">
        <input value={state.draft.blood_group} disabled={ro} maxLength={8}
               onChange={(e) => state.set('blood_group', e.target.value)} />
      </Field>
      <Field label="Nationality">
        <input value={state.draft.nationality} disabled={ro}
               onChange={(e) => state.set('nationality', e.target.value)} />
      </Field>
      <Field label="Personal email" hint="Reachable after the work address stops working.">
        <input type="email" value={state.draft.personal_email} disabled={ro}
               onChange={(e) => state.set('personal_email', e.target.value)} />
      </Field>
      <Field label="Alternate phone">
        <input value={state.draft.alternate_phone} disabled={ro}
               onChange={(e) => state.set('alternate_phone', e.target.value)} />
      </Field>

      <Field label="Current address">
        <textarea rows={2} value={state.draft.current_address} disabled={ro}
                  onChange={(e) => state.set('current_address', e.target.value)} />
      </Field>
      <Field label="City">
        <input value={state.draft.current_city} disabled={ro}
               onChange={(e) => state.set('current_city', e.target.value)} />
      </Field>
      <Field label="State">
        <input value={state.draft.current_state} disabled={ro}
               onChange={(e) => state.set('current_state', e.target.value)} />
      </Field>
      <Field label="PIN code">
        <input value={state.draft.current_postal_code} disabled={ro}
               onChange={(e) => state.set('current_postal_code', e.target.value)} />
      </Field>

      <Field label="Permanent address" hint="Statutory paperwork asks for this one specifically.">
        <textarea rows={2} value={state.draft.permanent_address} disabled={ro}
                  onChange={(e) => state.set('permanent_address', e.target.value)} />
      </Field>
      <Field label="City">
        <input value={state.draft.permanent_city} disabled={ro}
               onChange={(e) => state.set('permanent_city', e.target.value)} />
      </Field>
      <Field label="State">
        <input value={state.draft.permanent_state} disabled={ro}
               onChange={(e) => state.set('permanent_state', e.target.value)} />
      </Field>
      <Field label="PIN code">
        <input value={state.draft.permanent_postal_code} disabled={ro}
               onChange={(e) => state.set('permanent_postal_code', e.target.value)} />
      </Field>

      <Field label="Emergency contact">
        <input value={state.draft.emergency_name} disabled={ro}
               onChange={(e) => state.set('emergency_name', e.target.value)} />
      </Field>
      <Field label="Relationship">
        <input value={state.draft.emergency_relationship} disabled={ro}
               onChange={(e) => state.set('emergency_relationship', e.target.value)} />
      </Field>
      <Field label="Emergency phone">
        <input value={state.draft.emergency_phone} disabled={ro}
               onChange={(e) => state.set('emergency_phone', e.target.value)} />
      </Field>
    </SectionShell>
  )
}

/* --- statutory identity and bank ------------------------------------------ */

function StatutorySection({
  profile,
  onSaved,
}: {
  profile: EmployeeProfile
  onSaved: () => void
}) {
  const editable = profile.can_edit_personal
  const state = useSection(
    {
      // Never seeded with the real value — the page does not have it, by
      // design. Empty means "leave it alone"; typing replaces it.
      pan: '',
      aadhaar: '',
      uan: profile.uan ?? '',
      pf_number: profile.pf_number ?? '',
      esi_number: profile.esi_number ?? '',
      bank_name: profile.bank_name ?? '',
      bank_branch: profile.bank_branch ?? '',
      bank_ifsc: profile.bank_ifsc ?? '',
      bank_account: '',
      bank_account_name: profile.bank_account_name ?? '',
    },
    async (body) => {
      await api.patch(`/people/${profile.user_id}`, body)
      onSaved()
    },
  )

  const ro = !editable
  return (
    <SectionShell heading="Statutory & bank" editable={editable} state={state}>
      <Secret label="PAN" masked={profile.pan_masked} present={profile.has_pan}
              canReveal={profile.can_reveal} userId={profile.user_id} field="pan"
              value={state.draft.pan} disabled={ro}
              onChange={(v) => state.set('pan', v.toUpperCase())}
              placeholder="ABCDE1234F" />
      <Secret label="Aadhaar" masked={profile.aadhaar_masked} present={profile.has_aadhaar}
              canReveal={profile.can_reveal} userId={profile.user_id} field="aadhaar"
              value={state.draft.aadhaar} disabled={ro}
              onChange={(v) => state.set('aadhaar', v)}
              placeholder="1234 5678 9012" />
      <Field label="UAN">
        <input value={state.draft.uan} disabled={ro}
               onChange={(e) => state.set('uan', e.target.value)} />
      </Field>
      <Field label="PF number">
        <input value={state.draft.pf_number} disabled={ro}
               onChange={(e) => state.set('pf_number', e.target.value)} />
      </Field>
      <Field label="ESI number">
        <input value={state.draft.esi_number} disabled={ro}
               onChange={(e) => state.set('esi_number', e.target.value)} />
      </Field>

      <Field label="Bank">
        <input value={state.draft.bank_name} disabled={ro}
               onChange={(e) => state.set('bank_name', e.target.value)} />
      </Field>
      <Field label="Branch">
        <input value={state.draft.bank_branch} disabled={ro}
               onChange={(e) => state.set('bank_branch', e.target.value)} />
      </Field>
      <Field label="IFSC">
        <input value={state.draft.bank_ifsc} disabled={ro} placeholder="HDFC0001234"
               onChange={(e) => state.set('bank_ifsc', e.target.value.toUpperCase())} />
      </Field>
      <Secret label="Account number" masked={profile.bank_account_masked}
              present={profile.has_bank_account} canReveal={profile.can_reveal}
              userId={profile.user_id} field="bank_account"
              value={state.draft.bank_account} disabled={ro}
              onChange={(v) => state.set('bank_account', v)} />
      <Field label="Account holder">
        <input value={state.draft.bank_account_name} disabled={ro}
               onChange={(e) => state.set('bank_account_name', e.target.value)} />
      </Field>
    </SectionShell>
  )
}

/** A masked value with a deliberate Reveal.
 *
 *  Revealing is a POST that writes an audit row, so it happens on a click and
 *  never on load. Once revealed the value stays on screen only until the next
 *  render of the page — it is not written into the draft, because the draft is
 *  what gets submitted and re-submitting an unchanged secret would rewrite the
 *  column for no reason. */
function Secret({
  label, masked, present, canReveal, userId, field,
  value, disabled, onChange, placeholder,
}: {
  label: string
  masked: string | null
  present: boolean
  canReveal: boolean
  userId: string
  field: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
  placeholder?: string
}) {
  const [shown, setShown] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reveal = useCallback(async () => {
    setError(null)
    try {
      const body = await api.post<{ field: string; value: string }>(
        `/people/${userId}/reveal/${field}`,
      )
      setShown(body.value)
    } catch (caught) {
      setError((caught as Error).message)
    }
  }, [userId, field])

  return (
    <label className="hr-field">
      <span className="hr-field-label">{label}</span>
      <input
        value={value}
        disabled={disabled}
        placeholder={present ? (shown ?? masked ?? '') : (placeholder ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="hr-field-hint">
        {present ? (
          <>
            {shown ? 'Shown — this view was recorded.' : 'On file.'}
            {canReveal && !shown && (
              <button type="button" className="link-btn" onClick={reveal}>Reveal</button>
            )}
            {' '}Typing replaces it.
          </>
        ) : (
          'Not on file.'
        )}
        {error && <span className="err-inline"> {error}</span>}
      </span>
    </label>
  )
}

/* --- employment and confirmation ------------------------------------------ */

function EmploymentSection({
  profile,
  onSaved,
}: {
  profile: EmployeeProfile
  onSaved: () => void
}) {
  const editable = profile.can_edit_employment
  const state = useSection(
    {
      employment_type: profile.employment_type ?? '',
      work_location: profile.work_location ?? '',
      probation_months: profile.probation_months ?? ('' as number | ''),
      notice_period_days: profile.notice_period_days ?? ('' as number | ''),
      probation_end_on: profile.probation_end_on ?? '',
      bgv_status: profile.bgv_status ?? '',
      bgv_agency: profile.bgv_agency ?? '',
      bgv_completed_on: profile.bgv_completed_on ?? '',
      bgv_note: profile.bgv_note ?? '',
    },
    async (body) => {
      // A cleared *number* input arrives as '', and the server's `int | None`
      // rejects it — so clearing probation or a notice period would 422 rather
      // than empty the field. Strings are left alone: the server trims those to
      // null itself, and '' is how "cleared on purpose" reaches it.
      const cleaned = Object.fromEntries(
        Object.entries(body).map(([key, value]) => [
          key,
          value === '' && NUMERIC_EMPLOYMENT_FIELDS.has(key) ? null : value,
        ]),
      )
      await api.patch(`/people/${profile.user_id}/employment`, cleaned)
      onSaved()
    },
  )

  const ro = !editable
  return (
    <SectionShell heading="Employment" editable={editable} state={state}>
      <Field label="Joined on">
        {/* From `users`, not this record — attendance and leave accrual already
            read it there, and a second copy is the one that drifts. */}
        <input value={profile.joined_on ?? '—'} disabled readOnly />
      </Field>
      <Field label="Employment type">
        <select value={state.draft.employment_type} disabled={ro}
                onChange={(e) => state.set('employment_type', e.target.value)}>
          <option value="">—</option>
          {EMPLOYMENT.map((t) => <option key={t} value={t}>{title(t)}</option>)}
        </select>
      </Field>
      <Field label="Work location">
        <input value={state.draft.work_location} disabled={ro}
               onChange={(e) => state.set('work_location', e.target.value)} />
      </Field>
      <Field label="Probation (months)">
        <input type="number" min={0} max={36} value={state.draft.probation_months} disabled={ro}
               onChange={(e) =>
                 state.set('probation_months', e.target.value === '' ? '' : Number(e.target.value))
               } />
      </Field>
      <Field label="Notice period (days)">
        {/* Blank is not zero. A settlement reads this to work out whether
            notice was served, and says "not recorded" rather than recovering
            pay against a default nobody chose. */}
        <input type="number" min={0} max={365} value={state.draft.notice_period_days}
               disabled={ro} placeholder="not recorded"
               onChange={(e) =>
                 state.set('notice_period_days',
                           e.target.value === '' ? '' : Number(e.target.value))
               } />
      </Field>
      <Field label="Probation ends">
        <input type="date" value={state.draft.probation_end_on} disabled={ro}
               onChange={(e) => state.set('probation_end_on', e.target.value)} />
      </Field>
      <Field label="Background check">
        <input value={state.draft.bgv_status} disabled={ro} placeholder="pending / clear / flagged"
               onChange={(e) => state.set('bgv_status', e.target.value)} />
      </Field>
      <Field label="Agency">
        <input value={state.draft.bgv_agency} disabled={ro}
               onChange={(e) => state.set('bgv_agency', e.target.value)} />
      </Field>
      <Field label="Checked on">
        <input type="date" value={state.draft.bgv_completed_on} disabled={ro}
               onChange={(e) => state.set('bgv_completed_on', e.target.value)} />
      </Field>

      {editable && <Confirmation profile={profile} onSaved={onSaved} />}
    </SectionShell>
  )
}

/** Confirmation is an event, not a field — its own POST, its own audit row. */
function Confirmation({
  profile,
  onSaved,
}: {
  profile: EmployeeProfile
  onSaved: () => void
}) {
  const [status, setStatus] = useState(profile.confirmation_status)
  const [effective, setEffective] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await api.post(`/people/${profile.user_id}/confirmation`, {
        status,
        effective_on: effective || null,
        note: note || null,
      })
      setNote('')
      onSaved()
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hr-confirm">
      <h3 className="hr-subhead">Confirmation</h3>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="hr-confirm-row">
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          {CONFIRMATION.map((s) => <option key={s} value={s}>{title(s)}</option>)}
        </select>
        <input type="date" value={effective} onChange={(e) => setEffective(e.target.value)}
               aria-label="Effective date" />
        <input value={note} placeholder="Note" onChange={(e) => setNote(e.target.value)} />
        <button className="btn" onClick={submit}
                disabled={busy || status === profile.confirmation_status && !note && !effective}>
          {busy ? 'Saving…' : 'Record'}
        </button>
      </div>
      {profile.confirmation_note && (
        <p className="muted">Last note: {profile.confirmation_note}</p>
      )}
    </div>
  )
}
