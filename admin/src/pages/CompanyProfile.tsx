import { useEffect, useRef, useState } from 'react'
import '../styles/company.css'
import { api, fetchImage } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { canAdminister, useAuth } from '../lib/auth'
import type { CompanyProfile as Profile } from '../lib/types'
import { ErrorNote, Loading } from '../components/ui'
import { IconBuilding, IconClose, IconDownload } from '../components/Icons'

/**
 * Who this company is — and the logo that puts its name on the console.
 *
 * Everything on this page already existed on the `organizations` row and had no
 * editor: it was captured once at signup and then frozen, so a company that
 * moved office had a stale address printing on its own offer letters with no
 * way to correct it short of a database edit. That is the real job here. The
 * logo is the new part.
 *
 * Three decisions worth knowing before changing anything:
 *
 * **Reading is not editing.** Every employee may read the profile — it is on
 * their payslip and their offer letter already — and only an administrator sees
 * the form. A non-admin gets the same facts as plain text rather than a page
 * they are not allowed to have.
 *
 * **The form is a draft until it is saved.** Fields are held locally and sent
 * in one PUT, and only the fields that actually changed are sent, which is what
 * makes two administrators editing different halves of this page safe.
 *
 * **The logo is not part of that draft.** It uploads on selection and takes
 * effect immediately, because the thing it changes — the mark at the top of
 * every page — is visible on this very screen. Bundling it into Save would mean
 * choosing a file and then seeing nothing happen.
 */

/* The fields the form owns, in the order they are asked for. Split into groups
   because a flat list of fourteen boxes is a form nobody reads: these are three
   different questions — what the company is called, where it is, how to reach
   it — and the grouping is what lets somebody fix an address without reading
   past the GSTIN. */
interface Field {
  key: keyof Profile
  label: string
  hint?: string
  type?: 'text' | 'email' | 'tel' | 'url'
  wide?: boolean
}

const GROUPS: Array<{ heading: string; note: string; fields: Field[] }> = [
  {
    heading: 'Identity',
    note: 'The display name is what the console calls this workspace. The legal name is what goes on letters, payslips and Form 16 — it falls back to the display name when it is empty.',
    fields: [
      { key: 'name', label: 'Display name' },
      { key: 'legal_name', label: 'Registered legal name' },
      { key: 'industry', label: 'Industry' },
      { key: 'website', label: 'Website', type: 'url' },
      { key: 'gstin', label: 'GSTIN' },
    ],
  },
  {
    heading: 'Registered address',
    note: 'Printed on letters and payslips. This is the company address, not an employee work location — work locations live in Attendance settings, where the geofences are.',
    fields: [
      { key: 'address_line1', label: 'Address line 1', wide: true },
      { key: 'address_line2', label: 'Address line 2', wide: true },
      { key: 'city', label: 'City' },
      { key: 'state', label: 'State' },
      { key: 'postal_code', label: 'Postcode' },
      { key: 'country', label: 'Country', hint: 'Two-letter code, e.g. IN' },
    ],
  },
  {
    heading: 'Meetings',
    note: 'Video calls run on a Jitsi deployment. Left empty, they use the public meet.jit.si — free, and the media travels through servers this product does not run. Name your own Jitsi host to keep it in-house; nothing else about meetings changes.',
    fields: [
      { key: 'meeting_domain', label: 'Jitsi host', hint: 'e.g. meet.yourcompany.com — empty uses the public instance', wide: true },
    ],
  },
  {
    heading: 'Contact',
    note: 'Where somebody writes to the company itself. Not the address notifications are sent from — that is Email setup, which carries a credential and belongs to the account holder.',
    fields: [
      { key: 'contact_email', label: 'Contact email', type: 'email' },
      { key: 'contact_phone', label: 'Contact phone', type: 'tel' },
    ],
  },
]

/** The text fields, flattened — used to diff the draft against what was loaded. */
const EDITABLE = GROUPS.flatMap((group) => group.fields.map((field) => field.key))

export default function CompanyProfile() {
  const { user, organization } = useAuth()
  const editable = canAdminister(user)
  const q = useQuery<Profile>('company-profile', () => api.get<Profile>('/org/company'))

  const [draft, setDraft] = useState<Partial<Record<keyof Profile, string>>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  /* The loaded row is the baseline the draft is compared against. Seeding it in
     an effect rather than in useState means a reload after a save re-seeds it,
     so "changed" goes back to nothing instead of staying lit forever. */
  useEffect(() => {
    if (!q.data) return
    const seeded: Partial<Record<keyof Profile, string>> = {}
    for (const key of EDITABLE) seeded[key] = (q.data[key] as string | null) ?? ''
    setDraft(seeded)
  }, [q.data])

  if (q.loading) return <Loading />
  if (q.error) return <ErrorNote>{q.error}</ErrorNote>
  if (!q.data) return null
  const profile = q.data

  const changed = EDITABLE.filter(
    (key) => (draft[key] ?? '') !== ((profile[key] as string | null) ?? ''),
  )

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

  return (
    <div className="page co">
      <div className="page-head">
        <div>
          <h1 className="page-title">Company profile</h1>
          <p className="page-sub">
            {editable
              ? 'Your company’s name, address and contact details — and the logo that brands this console for everyone who signs in.'
              : 'Your company’s name, address and contact details.'}
          </p>
        </div>
      </div>

      {note && (
        <div className="notice notice-ok" role="status">
          {note}
        </div>
      )}
      {failure && <ErrorNote>{failure}</ErrorNote>}

      <LogoCard profile={profile} editable={editable} />

      {editable ? (
        <>
          {GROUPS.map((group) => (
            <section className="card co-group" key={group.heading}>
              <div className="co-group-head">
                <h2 className="card-title">{group.heading}</h2>
                <p className="co-group-note">{group.note}</p>
              </div>
              <div className="co-fields">
                {group.fields.map((field) => (
                  <label
                    className={`co-field${field.wide ? ' co-field-wide' : ''}`}
                    key={String(field.key)}
                  >
                    <span className="co-field-label">{field.label}</span>
                    <input
                      type={field.type ?? 'text'}
                      value={draft[field.key] ?? ''}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, [field.key]: event.target.value }))
                      }
                    />
                    {field.hint && <span className="co-field-hint">{field.hint}</span>}
                  </label>
                ))}
              </div>
            </section>
          ))}

          {/* Sticky, because this form is three cards long and a save button at
              the bottom of it is a save button somebody has to go looking for
              after every edit. */}
          <div className="co-bar">
            <span className="co-bar-note">
              {changed.length === 0
                ? 'No unsaved changes.'
                : `${changed.length} ${changed.length === 1 ? 'field' : 'fields'} changed.`}
            </span>
            <button
              className="btn"
              disabled={busy || changed.length === 0}
              onClick={() => {
                const seeded: Partial<Record<keyof Profile, string>> = {}
                for (const key of EDITABLE) seeded[key] = (profile[key] as string | null) ?? ''
                setDraft(seeded)
              }}
            >
              Discard
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || changed.length === 0}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </>
      ) : (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">Company details</h2>
          </div>
          <dl className="co-readonly">
            {GROUPS.flatMap((group) => group.fields).map((field) => {
              const value = (profile[field.key] as string | null) ?? null
              if (!value) return null
              return (
                <div key={String(field.key)}>
                  <dt>{field.label}</dt>
                  <dd>{value}</dd>
                </div>
              )
            })}
          </dl>
          <p className="co-readonly-note">
            An administrator can change these in Settings. Your workspace timezone is{' '}
            {organization?.timezone ?? profile.timezone}.
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
function LogoCard({ profile, editable }: { profile: Profile; editable: boolean }) {
  const [src, setSrc] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
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
         read once at boot. A reload is heavy-handed and it is honest — the
         alternative is a second copy of the logo state living in two places. */
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

  return (
    <section className="card co-logo">
      <div className="co-logo-body">
        <div className="co-group-head">
          <h2 className="card-title">Console logo</h2>
          <p className="co-group-note">
            Replaces the MyDeskTime mark at the top of the navigation for everyone who signs in
            to this workspace. PNG with a transparent background reads best — it has to sit on
            both the light and the dark theme. Up to 2 MB; it is stored at 512px and drawn at 30.
          </p>
        </div>

        {editable && (
          <div className="co-logo-actions">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                // Cleared so choosing the same file twice still fires a change,
                // which is how somebody retries after a failed upload.
                event.target.value = ''
                if (file) void send(file)
              }}
            />
            <button className="btn btn-primary" disabled={busy} onClick={() => fileRef.current?.click()}>
              <IconDownload size={15} />
              {busy ? 'Working…' : profile.has_logo ? 'Replace logo' : 'Upload a logo'}
            </button>
            {profile.has_logo && (
              <button className="btn" disabled={busy} onClick={() => void remove()}>
                <IconClose size={15} /> Remove
              </button>
            )}
          </div>
        )}

        {failure && <ErrorNote>{failure}</ErrorNote>}
      </div>

      {/* Shown on both themes at once, side by side. A logo that looks right on
          white and disappears on the dark rail is the single most common way
          this goes wrong, and the only way to catch it is to see both. */}
      <div className="co-preview">
        <span className="co-preview-label">Preview</span>
        <div className="co-preview-pair">
          <div className="co-preview-tile co-preview-light">
            {src ? (
              <img src={src} alt={`${profile.name} logo`} />
            ) : (
              <span className="co-preview-none"><IconBuilding size={18} /> No logo</span>
            )}
          </div>
          <div className="co-preview-tile co-preview-dark">
            {src ? (
              <img src={src} alt="" />
            ) : (
              <span className="co-preview-none"><IconBuilding size={18} /> No logo</span>
            )}
          </div>
        </div>
        <span className="co-preview-hint">Light rail · dark rail</span>
      </div>
    </section>
  )
}
