import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import '../styles/company.css'
import '../styles/companyProfile.css'
import { api, fetchImage, postHtml } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { canAdminister, useAuth } from '../lib/auth'
import type { CompanyProfile as Profile } from '../lib/types'
import { ErrorNote, Loading } from '../components/ui'
import { IconBuilding } from '../components/Icons'

/**
 * Who this company is — and the logo that puts its name on the console.
 *
 * Three decisions worth knowing before changing anything:
 *
 * **Reading is not editing.** Every employee may read the profile — it is on
 * their payslip and their offer letter already — and only an administrator sees
 * the form. A non-admin gets the same facts as plain text.
 *
 * **The form is a draft until it is saved.** Fields are held locally and sent
 * in one PUT, and only the fields that actually changed are sent, which is what
 * makes two administrators editing different halves of this page safe.
 *
 * **The logo is not part of that draft.** It uploads on selection and takes
 * effect immediately, because the thing it changes — the mark at the top of
 * every page — is visible on this very screen.
 */

type Draft = Partial<Record<keyof Profile, string>>

const EDITABLE: Array<keyof Profile> = [
  'name', 'legal_name', 'industry', 'website', 'gstin',
  'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country',
  'contact_email', 'contact_phone',
]

const LABELS: Record<string, string> = {
  name: 'Display name', legal_name: 'Registered legal name', industry: 'Industry', website: 'Website', gstin: 'GSTIN',
  address_line1: 'Address line 1', address_line2: 'Address line 2', city: 'City', state: 'State', postal_code: 'Postcode',
  country: 'Country', contact_email: 'Contact email', contact_phone: 'Contact phone',
}

/** GST state codes: the first two digits of a GSTIN say which state it was registered in. */
const GST_STATE: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
  '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman & Nicobar', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
}
const GSTIN_SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

const COUNTRY = { IN: 'India' } as Record<string, string>

function Card({ icon, title, sub, children }: { icon: ReactNode; title: string; sub: ReactNode; children: ReactNode }) {
  return (
    <section className="cp-card">
      <header className="cp-head">
        <i aria-hidden>{icon}</i>
        <div><h2>{title}</h2><p>{sub}</p></div>
      </header>
      <div className="cp-body">{children}</div>
    </section>
  )
}

function Field({ label, req, hint, badges, wide, children }: {
  label: string; req?: boolean; hint?: ReactNode; badges?: ReactNode; wide?: boolean; children: ReactNode
}) {
  return (
    <label className={`cp-f${wide ? ' is-wide' : ''}`}>
      <span className="cp-fl">{label}{req && <b> *</b>}{badges && <span className="cp-badges">{badges}</span>}</span>
      {children}
      {hint && <span className="cp-hint">{hint}</span>}
    </label>
  )
}

export default function CompanyProfile() {
  const { user, organization } = useAuth()
  const editable = canAdminister(user)
  const q = useQuery<Profile>('company-profile', () => api.get<Profile>('/org/company'))

  const [draft, setDraft] = useState<Draft>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  /* The loaded row is the baseline the draft is compared against. Seeding it in
     an effect rather than in useState means a reload after a save re-seeds it,
     so "changed" goes back to nothing instead of staying lit forever. */
  useEffect(() => {
    if (!q.data) return
    const seeded: Draft = {}
    for (const key of EDITABLE) seeded[key] = (q.data[key] as string | null) ?? ''
    setDraft(seeded)
  }, [q.data])

  if (q.loading) return <Loading />
  if (q.error) return <ErrorNote>{q.error}</ErrorNote>
  if (!q.data) return null
  const profile = q.data

  const changed = EDITABLE.filter((key) => (draft[key] ?? '') !== ((profile[key] as string | null) ?? ''))
  const v = (key: keyof Profile) => draft[key] ?? ''
  const set = (key: keyof Profile, value: string) => setDraft((cur) => ({ ...cur, [key]: value }))

  async function save() {
    setBusy(true)
    setFailure(null)
    setNote(null)
    try {
      /* Only what changed. Sending the whole form back would make every save a
         claim about fields the person never looked at, and would overwrite an
         edit somebody else made to the other half of the page in the meantime. */
      const body: Record<string, string> = {}
      for (const key of changed) body[key] = draft[key] ?? ''
      await api.put<Profile>('/org/company', body)
      setNote('Company details saved.')
      q.reload()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'Those details could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  async function previewLetterhead() {
    // Opens the saved letterhead as it will print; the window is opened first so the click is not blocked as a popup.
    const w = window.open('', '_blank')
    try {
      const saved = await api.get<{ settings: Record<string, unknown> }>('/payslip-design/letterhead')
      const html = await postHtml('/payslip-design/letterhead/preview', saved.settings)
      if (w) { w.document.open(); w.document.write(html); w.document.close() }
    } catch (err) {
      w?.close()
      setFailure(err instanceof Error ? err.message : 'The letterhead could not be previewed.')
    }
  }

  const gstin = v('gstin').trim().toUpperCase()
  const gstinOk = GSTIN_SHAPE.test(gstin)
  const gstState = gstin.length >= 2 ? GST_STATE[gstin.slice(0, 2)] : undefined
  const web = v('website').replace(/^https?:\/\//i, '')
  const country = v('country').toUpperCase()
  const place = [v('city'), v('state')].filter(Boolean).join(', ')
  const heading = v('legal_name') || v('name') || 'Company name'

  return (
    <div className="page cp">
      <div className="cp-top">
        <div>
          <h1 className="page-title">Company profile</h1>
          <p className="page-sub">
            {editable
              ? 'Manage your organisation’s legal identity, console branding, registered address and official contact details.'
              : 'Your company’s name, address and contact details.'}
          </p>
        </div>
        {editable && (
          <div className="cp-top-actions">
            <span className="cp-active"><i aria-hidden />Workspace active</span>
            <button type="button" className="btn" onClick={() => void previewLetterhead()}>Preview letterhead</button>
          </div>
        )}
      </div>

      {note && <div className="notice notice-ok" role="status">{note}</div>}
      {failure && <ErrorNote>{failure}</ErrorNote>}

      {editable ? (
        <>
          <div className="cp-grid">
            <div className="cp-col">
              <Card icon={<IconBuilding size={18} />} title="Identity & registration"
                    sub="Display name appears across the workspace; legal name, address and GSTIN appear on letters, payslips and Form 16.">
                <div className="cp-two">
                  <Field label="Display name" req hint="Used in the top navigation, emails and the employee portal.">
                    <input value={v('name')} placeholder="e.g. Acme" onChange={(e) => set('name', e.target.value)} />
                  </Field>
                  <Field label="Registered legal name" hint="Falls back to the display name when left empty.">
                    <input value={v('legal_name')} placeholder="e.g. Acme Industries Pvt Ltd" onChange={(e) => set('legal_name', e.target.value)} />
                  </Field>
                  <Field label="Industry">
                    <input value={v('industry')} placeholder="e.g. Software & IT Services" onChange={(e) => set('industry', e.target.value)} />
                  </Field>
                  <Field label="Website">
                    <span className="cp-in"><em>https://</em>
                      <input value={web} placeholder="www.example.com"
                             onChange={(e) => set('website', e.target.value.trim() ? `https://${e.target.value.trim().replace(/^https?:\/\//i, '')}` : '')} />
                    </span>
                  </Field>
                </div>
                <Field label="GSTIN (Goods and Services Tax Identification Number)" wide
                       badges={gstin ? <>
                         <span className={`cp-badge ${gstinOk ? 'is-ok' : 'is-bad'}`}>{gstinOk ? 'Valid 15-char GSTIN' : 'Not a valid GSTIN'}</span>
                         {gstState && <span className="cp-badge">{gstin.slice(0, 2)} · {gstState}</span>}
                       </> : undefined}
                       hint="15-character tax registration number printed on statutory invoices, Form 16 headers and compliance filings.">
                  <input className="is-mono" maxLength={15} value={v('gstin')} placeholder="22AAAAA0000A1Z5"
                         onChange={(e) => set('gstin', e.target.value.toUpperCase())} />
                </Field>
              </Card>

              <Card icon={<IconBuilding size={18} />} title="Registered address"
                    sub={<>Printed on official letters and payslips. Employee work locations and geofences are managed in <Link to="/hrms/settings?tab=attendance">Attendance settings</Link>.</>}>
                <Field label="Address line 1" wide>
                  <input value={v('address_line1')} placeholder="e.g. 12, MG Road, Fort" onChange={(e) => set('address_line1', e.target.value)} />
                </Field>
                <Field label="Address line 2 (optional)" wide>
                  <input value={v('address_line2')} placeholder="e.g. Near City Mall, Landmark" onChange={(e) => set('address_line2', e.target.value)} />
                </Field>
                <div className="cp-two">
                  <Field label="City"><input value={v('city')} onChange={(e) => set('city', e.target.value)} /></Field>
                  <Field label="State"><input value={v('state')} onChange={(e) => set('state', e.target.value)} /></Field>
                  <Field label="Post / PIN code"><input value={v('postal_code')} placeholder="6-digit pincode" inputMode="numeric" onChange={(e) => set('postal_code', e.target.value)} /></Field>
                  <Field label="Country" hint="Two-letter ISO code, e.g. IN">
                    <span className="cp-in"><em>{country || '--'}</em>
                      <input maxLength={2} value={v('country')} placeholder="IN" onChange={(e) => set('country', e.target.value.toUpperCase())} />
                      {COUNTRY[country] && <small>{COUNTRY[country]}</small>}
                    </span>
                  </Field>
                </div>
              </Card>

              <Card icon={<IconBuilding size={18} />} title="Official contact"
                    sub={<>Public contact details shown to employees and external recipients. Notification sender credentials are configured in <Link to="/settings/email">Email setup</Link>.</>}>
                <div className="cp-two">
                  <Field label="Contact email">
                    <input type="email" value={v('contact_email')} placeholder="name@company.com" onChange={(e) => set('contact_email', e.target.value)} />
                  </Field>
                  <Field label="Contact phone">
                    <input type="tel" value={v('contact_phone')} placeholder="+91 98200 00000" onChange={(e) => set('contact_phone', e.target.value)} />
                  </Field>
                </div>
              </Card>
            </div>

            <aside className="cp-col">
              <LogoCard profile={profile} name={v('name') || profile.name} />
              <section className="cp-card">
                <header className="cp-head is-slim"><div><h2>Live document header</h2></div><span className="cp-sync">Real-time sync</span></header>
                <div className="cp-body">
                  <div className="cp-doc">
                    <i aria-hidden><IconBuilding size={16} /></i>
                    <div>
                      <b>{heading}</b>
                      <span>{[place, country].filter(Boolean).join(' · ') || 'Add the registered address'}</span>
                      {gstin && <code>GSTIN: {gstin}</code>}
                      {(v('contact_email') || v('contact_phone')) && <em>{[v('contact_email'), v('contact_phone')].filter(Boolean).join(' · ')}</em>}
                    </div>
                  </div>
                </div>
              </section>
            </aside>
          </div>

          {/* Sticky, because this form is three cards long and a save button at
              the bottom of it is a save button somebody has to go looking for
              after every edit. */}
          <div className="co-bar">
            <span className="co-bar-note">
              {changed.length === 0
                ? 'No unsaved changes.'
                : `${changed.length} ${changed.length === 1 ? 'field' : 'fields'} changed: ${changed.map((k) => LABELS[k as string] ?? String(k)).join(', ')}.`}
            </span>
            <button className="btn" disabled={busy || changed.length === 0}
                    onClick={() => {
                      const seeded: Draft = {}
                      for (const key of EDITABLE) seeded[key] = (profile[key] as string | null) ?? ''
                      setDraft(seeded)
                    }}>
              Discard
            </button>
            <button className="btn btn-primary" disabled={busy || changed.length === 0 || !v('name').trim()} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </>
      ) : (
        <section className="card">
          <div className="card-head"><h2 className="card-title">Company details</h2></div>
          <dl className="co-readonly">
            {EDITABLE.map((key) => {
              const value = (profile[key] as string | null) ?? null
              if (!value) return null
              return <div key={String(key)}><dt>{LABELS[key as string]}</dt><dd>{value}</dd></div>
            })}
          </dl>
          <p className="co-readonly-note">
            An administrator can change these in Settings. Your workspace timezone is {organization?.timezone ?? profile.timezone}.
          </p>
        </section>
      )}
    </div>
  )
}

/* ----------------------------------------------------------------- logo --- */

/**
 * Upload, preview and remove.
 *
 * The preview is fetched with a token like every other stored object, and it is
 * keyed on `logo_updated_at` so replacing the file actually re-fetches it — the
 * endpoint is a per-tenant singleton at one unchanging path, and without the
 * key the browser would keep serving the image it already had.
 */
function LogoCard({ profile, name }: { profile: Profile; name: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const stamp = profile.logo_updated_at

  useEffect(() => {
    if (!stamp) {
      setSrc(null)
      return
    }
    let objectUrl: string | null = null
    let cancelled = false
    fetchImage(`/api/v1/org/company/logo?v=${encodeURIComponent(stamp)}`)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url)
          return
        }
        objectUrl = url
        setSrc(url)
      })
      .catch(() => !cancelled && setSrc(null))
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [stamp])

  async function send(file: File) {
    setBusy(true)
    setFailure(null)
    try {
      const body = new FormData()
      body.append('file', file)
      await api.upload<Profile>('/org/company/logo', body)
      /* The whole app reloads rather than this card alone: the mark at the top
         of every page comes from the tenant on the auth context, and that is
         read once at boot. */
      window.location.reload()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'That logo could not be uploaded.')
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setFailure(null)
    try {
      await api.del('/org/company/logo')
      window.location.reload()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'That logo could not be removed.')
      setBusy(false)
    }
  }

  const mark = src ? <img src={src} alt="" /> : <i className="cp-mark" aria-hidden><IconBuilding size={14} /></i>

  return (
    <section className="cp-card">
      <header className="cp-head is-slim">
        <div><h2>Console logo</h2></div>
        <span className="cp-sync">PNG / SVG · 2 MB</span>
      </header>
      <div className="cp-body">
        <p className="cp-note">
          Replaces the MyDeskTime mark at the top of the navigation for everyone who signs in. Stored at <b>512px</b> and drawn at <b>30px</b>.
        </p>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden
               onChange={(event) => {
                 const file = event.target.files?.[0]
                 // Cleared so choosing the same file twice still fires a change, which is how somebody retries after a failed upload.
                 event.target.value = ''
                 if (file) void send(file)
               }} />
        <div className={`cp-drop${over ? ' is-over' : ''}`} role="button" tabIndex={0}
             onClick={() => !busy && fileRef.current?.click()}
             onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click() }}
             onDragOver={(e) => { e.preventDefault(); setOver(true) }}
             onDragLeave={() => setOver(false)}
             onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f && !busy) void send(f) }}>
          {src ? <img src={src} alt={`${profile.name} logo`} className="cp-drop-img" /> : <span className="cp-drop-ic" aria-hidden>⬆</span>}
          <b>{busy ? 'Working…' : <>Click to upload <span>or drag &amp; drop</span></>}</b>
          <small>Transparent PNG or SVG recommended</small>
        </div>
        {profile.has_logo && (
          <button type="button" className="cp-reset" disabled={busy} onClick={() => void remove()}>Reset to empty</button>
        )}
        {failure && <ErrorNote>{failure}</ErrorNote>}

        <div className="cp-rail-label"><span>Navigation rail preview</span><em>30px draw height</em></div>
        <div className="cp-rails">
          <div className="cp-rail is-light"><div className="cp-rail-top">{mark}<div><b>{name}</b><span>Workspace</span></div></div><div className="cp-rail-bars"><i /><i /></div><small>Light rail</small></div>
          <div className="cp-rail is-dark"><div className="cp-rail-top">{mark}<div><b>{name}</b><span>Workspace</span></div></div><div className="cp-rail-bars"><i /><i /></div><small>Dark rail</small></div>
        </div>
      </div>
    </section>
  )
}
