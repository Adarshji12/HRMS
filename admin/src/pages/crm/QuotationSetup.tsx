/* CRM Settings → Quotation. Everything a new quotation is set up with.
 *
 * One screen, one Save: the style, the letterhead, numbering, payment details,
 * terms, footer and stamp. The server keeps the setup as one document
 * (schemas/crm.py QuotationSetup), so the form edits a copy of it and sends
 * the whole thing back. The logo and the stamp are the exception — they
 * upload the moment a file is chosen, because a file is not form state.
 *
 * Copied onto each quotation as it is created, so a change here never
 * rewrites a document already issued.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import '../../styles/crm.css'
import '../../styles/quotation-setup.css'
import { api, fetchImage } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { ErrorNote, Loading } from '../../components/ui'
import {
  IconAlert,
  IconBuilding,
  IconCard,
  IconInfo,
  IconMail,
  IconPanel,
  IconSheet,
  IconStar,
  IconUpload,
} from '../../components/Icons'
import { crm, crmError, type CrmSettings, type QuotationSetup } from './api'
import { Field } from './parts'

type Draft = {
  quotation_prefix: string
  quotation_validity_days: number
  quotation_terms: string
  setup: QuotationSetup
}

const FORMAT_EXAMPLES = ['{PREFIX}/{FY}/{SEQ}', '{PREFIX}-{YYYY}-{SEQ}', '{PREFIX}/{YY}{MM}/{SEQ}']

/** What the covering letter can name; filled in per quotation. */
const LETTER_TOKENS = ['{customer}', '{company}', '{number}', '{date}']

type SubTab = 'basics' | 'letterhead' | 'letter'

function fromSettings(row: CrmSettings): Draft {
  return {
    quotation_prefix: row.quotation_prefix,
    quotation_validity_days: row.quotation_validity_days,
    quotation_terms: row.quotation_terms ?? '',
    setup: { ...row.quotation_setup },
  }
}

/** The number a format gives today — the console's own rendering, for the
 *  preview while the format is being typed. The server's is the real one. */
function renderNumber(format: string, prefix: string, seq: string): string {
  const today = new Date()
  const fyStart = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1
  return (format || '{PREFIX}-{YYYY}-{SEQ}')
    .replace(/\{PREFIX\}/g, prefix)
    .replace(/\{FY\}/g, `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`)
    .replace(/\{YYYY\}/g, String(today.getFullYear()))
    .replace(/\{YY\}/g, String(today.getFullYear() % 100).padStart(2, '0'))
    .replace(/\{MM\}/g, String(today.getMonth() + 1).padStart(2, '0'))
    .replace(/\{SEQ\}/g, seq)
}

export default function QuotationSetupPanel() {
  const settings = useQuery<CrmSettings>('crm-settings', () => crm.settings())
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [subTab, setSubTab] = useState<SubTab>('basics')

  useEffect(() => {
    if (settings.data && !draft) setDraft(fromSettings(settings.data))
  }, [settings.data, draft])

  if (settings.loading && !settings.data) return <Loading />
  if (!settings.data || !draft) {
    return <ErrorNote>{crmError(settings.cause, 'Could not read the settings')}</ErrorNote>
  }

  const original = fromSettings(settings.data)
  const dirty = JSON.stringify(draft) !== JSON.stringify(original)
  const setup = draft.setup
  const set = (patch: Partial<QuotationSetup>) =>
    setDraft((d) => (d ? { ...d, setup: { ...d.setup, ...patch } } : d))
  const setTop = (patch: Partial<Omit<Draft, 'setup'>>) => setDraft((d) => (d ? { ...d, ...patch } : d))

  // The server's preview is exact; once prefix or format is being edited, the
  // console shows the shape of it instead.
  const numberingEdited =
    draft.quotation_prefix !== original.quotation_prefix ||
    (setup.number_format ?? '') !== (original.setup.number_format ?? '')
  const preview = numberingEdited
    ? renderNumber(setup.number_format ?? '', draft.quotation_prefix || 'QT', '0001')
    : settings.data.quotation_next_number

  async function save() {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      const { has_logo: _l, has_stamp: _s, images_version: _v, ...body } = draft.setup
      await crm.saveSettings({
        quotation_prefix: draft.quotation_prefix.trim(),
        quotation_validity_days: draft.quotation_validity_days,
        quotation_terms: draft.quotation_terms,
        quotation_setup: body as QuotationSetup,
      })
      await settings.reload()
      setDraft(null)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(crmError(err, 'Those settings could not be saved'))
    } finally {
      setBusy(false)
    }
  }

  function afterImage() {
    // Only the image flags change; keep what is being typed.
    void settings.reload()
  }

  const version = settings.data.quotation_setup.images_version
  const detailed = setup.style === 'detailed'
  // Only Detailed / Proposal has a letterhead and a covering letter to set up.
  const showing: SubTab = detailed ? subTab : 'basics'

  return (
    <div className="qs">
      <div className="qs-bar">
        <p className="qs-note">
          <IconInfo size={15} />
          <span>
            These details are copied onto each quotation as it is created — changes here affect{' '}
            <strong>new</strong> quotations only.
          </span>
        </p>
        {saved && <span className="crm-state crm-state-good">Saved</span>}
        {dirty && (
          <button type="button" className="link-btn" onClick={() => setDraft(original)}>
            Discard
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}

      <Card icon={<IconSheet size={16} />} title="Quotation style">
        <div className="qs-styles" role="radiogroup" aria-label="Quotation style">
          {([
            ['simple', 'Simple', 'Items, totals, terms and payment details on one clean page.'],
            ['detailed', 'Detailed / Proposal',
              'A multi-page B2B proposal: coloured letterhead from your company details, covering letter, bordered price table with HSN, then terms and bank details.'],
          ] as const).map(([key, title, body]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={setup.style === key}
              className={`qs-style${setup.style === key ? ' is-on' : ''}`}
              onClick={() => set({ style: key })}
            >
              <span className="qs-radio" aria-hidden />
              <span>
                <strong>{title}</strong>
                <span>{body}</span>
              </span>
            </button>
          ))}
        </div>
        {setup.style !== original.setup.style && (
          <p className="qs-switch-note">
            <IconAlert size={14} /> Save to switch. Quotations already raised keep the details they were
            created with.
          </p>
        )}
      </Card>

      {detailed && (
        <nav className="qs-subtabs" aria-label="Proposal setup">
          {([
            ['basics', 'Basics', <IconBuilding key="b" size={15} />],
            ['letterhead', 'Letterhead', <IconPanel key="l" size={15} />],
            ['letter', 'Letter & terms', <IconMail key="t" size={15} />],
          ] as const).map(([key, label, icon]) => (
            <button key={key} type="button" className={`qs-subtab${showing === key ? ' is-on' : ''}`}
                    aria-current={showing === key ? 'page' : undefined} onClick={() => setSubTab(key)}>
              {icon} {label}
            </button>
          ))}
        </nav>
      )}

      {showing === 'letterhead' && <LetterheadPanel setup={setup} set={set} />}
      {showing === 'letter' && <LetterPanel setup={setup} set={set} />}

      {showing === 'basics' && <div className="qs-columns">
        <div className="qs-column">
          <Card icon={<IconBuilding size={16} />} title="Company details"
                hint="The letterhead printed at the top of every quotation.">
            <div className="crm-grid-2">
              <Field label="Company name">
                <input value={setup.company_name ?? ''} placeholder="Your company's registered name"
                       onChange={(e) => set({ company_name: e.target.value })} />
              </Field>
              <Field label="Phone">
                <input value={setup.phone ?? ''} placeholder="+91 98765 43210"
                       onChange={(e) => set({ phone: e.target.value })} />
              </Field>
              <Field label="Email">
                <input type="email" value={setup.email ?? ''} placeholder="sales@company.com"
                       onChange={(e) => set({ email: e.target.value })} />
              </Field>
              <Field label="Website">
                <input value={setup.website ?? ''} placeholder="www.company.com"
                       onChange={(e) => set({ website: e.target.value })} />
              </Field>
              <Field label="GSTIN"
                     hint="Its first two digits set your GST state. Blank uses the state in Company profile.">
                <input value={setup.gstin ?? ''} placeholder="22AAAAA0000A1Z5" maxLength={15}
                       onChange={(e) => set({ gstin: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="Address">
                <textarea rows={2} value={setup.address ?? ''} placeholder="Building, street, area, city, PIN"
                          onChange={(e) => set({ address: e.target.value })} />
              </Field>
            </div>
            <ImageField kind="logo" label="Logo" hint="PNG or JPG, under 2 MB."
                        present={setup.has_logo ?? false} version={version} onChange={afterImage} />
          </Card>

          <Card icon={<span className="qs-hash" aria-hidden>#</span>} title="Numbering & defaults"
                hint="Numbers run in sequence and restart each period. A deleted quotation never gives its number back.">
            <div className="crm-grid-2">
              <Field label="Prefix">
                <input value={draft.quotation_prefix} maxLength={12}
                       onChange={(e) => setTop({ quotation_prefix: e.target.value })} />
              </Field>
              <Field label="Next number looks like"
                     hint={numberingEdited ? 'The exact number shows after saving.' : undefined}>
                <input className="qs-mono" value={preview} readOnly tabIndex={-1} />
              </Field>
              <div className="crm-form-wide">
                <Field label="Number format (optional)"
                       hint="Blank keeps PREFIX-YEAR-0001. {FY} is the financial year and restarts the count every April.">
                  <input className="qs-mono" value={setup.number_format ?? ''} maxLength={40}
                         placeholder="{PREFIX}/{FY}/{SEQ}"
                         onChange={(e) => set({ number_format: e.target.value })} />
                </Field>
                <div className="qs-chips">
                  {FORMAT_EXAMPLES.map((example) => (
                    <button key={example} type="button" className="qs-chip"
                            onClick={() => set({ number_format: example })}>
                      {example}
                    </button>
                  ))}
                </div>
              </div>
              <Field label="Valid for (days)" hint="Sets the Valid until date on a new quotation.">
                <input type="number" min={1} max={365} value={draft.quotation_validity_days}
                       onChange={(e) => setTop({ quotation_validity_days: Number(e.target.value) })} />
              </Field>
              <Field label="Default GST %" hint="Used when a product carries no rate of its own.">
                <input type="number" min={0} max={28} step="0.01" value={setup.default_gst}
                       onChange={(e) => set({ default_gst: e.target.value })} />
              </Field>
            </div>
          </Card>
        </div>

        <div className="qs-column">
          <Card icon={<IconCard size={16} />} title="Payment details"
                hint="How the customer pays. Each block is printed only when it is switched on.">
            <Toggle label="Bank transfer" hint="Account and IFSC, printed under the totals."
                    on={setup.bank_enabled} onChange={(on) => set({ bank_enabled: on })}>
              <div className="crm-grid-2">
                <Field label="Bank name">
                  <input value={setup.bank_name ?? ''} onChange={(e) => set({ bank_name: e.target.value })} />
                </Field>
                <Field label="Account holder">
                  <input value={setup.account_name ?? ''} onChange={(e) => set({ account_name: e.target.value })} />
                </Field>
                <Field label="Account number">
                  <input value={setup.account_number ?? ''} inputMode="numeric"
                         onChange={(e) => set({ account_number: e.target.value })} />
                </Field>
                <Field label="IFSC">
                  <input value={setup.ifsc ?? ''} maxLength={11} placeholder="HDFC0001234"
                         onChange={(e) => set({ ifsc: e.target.value.toUpperCase() })} />
                </Field>
                <Field label="Branch">
                  <input value={setup.branch ?? ''} onChange={(e) => set({ branch: e.target.value })} />
                </Field>
              </div>
            </Toggle>
            <Toggle label="UPI" hint="A QR code is made from the UPI ID and the quotation total — nothing to upload."
                    on={setup.upi_enabled} onChange={(on) => set({ upi_enabled: on })}>
              <div className="crm-grid-2">
                <Field label="UPI ID">
                  <input value={setup.upi_id ?? ''} placeholder="company@okhdfc"
                         onChange={(e) => set({ upi_id: e.target.value.trim() })} />
                </Field>
                <Field label="Payee name">
                  <input value={setup.upi_name ?? ''} onChange={(e) => set({ upi_name: e.target.value })} />
                </Field>
              </div>
            </Toggle>
          </Card>

          <Card icon={<IconStar size={16} />} title="Terms, footer & stamp"
                hint="Written once and carried onto every new quotation, where it can still be edited for that one document.">
            <Field label="Terms & conditions">
              <textarea rows={4} value={draft.quotation_terms}
                        placeholder={'1. Prices are valid until the date stated above.\n2. 50% advance, balance before delivery.\n3. Taxes as applicable.'}
                        onChange={(e) => setTop({ quotation_terms: e.target.value })} />
            </Field>
            <div className="crm-grid-2">
              <Field label="Footer message" hint="Printed above the signature.">
                <textarea rows={2} value={setup.footer ?? ''}
                          placeholder="Thank you for your interest. We look forward to working with you."
                          onChange={(e) => set({ footer: e.target.value })} />
              </Field>
              <Field label="Authorised signatory">
                <input value={setup.signatory ?? ''} placeholder="Name printed under the signature line"
                       onChange={(e) => set({ signatory: e.target.value })} />
              </Field>
            </div>
            <ImageField kind="stamp" label="Company stamp"
                        hint="Printed over the signature line. A transparent PNG looks like the real stamp — a JPG brings its white box with it."
                        present={setup.has_stamp ?? false} version={version} onChange={afterImage} />
          </Card>
        </div>
      </div>}
    </div>
  )
}

type SetFn = (patch: Partial<QuotationSetup>) => void

/** Detailed / Proposal → Letterhead: how the top of every page looks, with a
 *  live preview built from the company details on Basics. */
function LetterheadPanel({ setup, set }: { setup: QuotationSetup; set: SetFn }) {
  const contact = [setup.phone, setup.email, setup.website].filter(Boolean).join('  ·  ')
  const ids = [
    setup.show_gstin_in_header && setup.gstin ? `GSTIN ${setup.gstin}` : null,
    setup.cin ? `CIN ${setup.cin}` : null,
    setup.pan ? `PAN ${setup.pan}` : null,
  ].filter(Boolean).join('  ·  ')
  return (
    <div className="qs-columns">
      <Card icon={<IconPanel size={16} />} title="Letterhead"
            hint="The band across the top of every page of the proposal.">
        <div className="crm-grid-2">
          <Field label="Accent colour" hint="The band, headings and table borders.">
            <span className="qs-color">
              <input type="color" value={setup.accent_color}
                     onChange={(e) => set({ accent_color: e.target.value })} aria-label="Accent colour" />
              <input className="qs-mono" value={setup.accent_color} maxLength={7}
                     onChange={(e) => set({ accent_color: e.target.value })} />
            </span>
          </Field>
          <Field label="Logo position">
            <select value={setup.letterhead_align}
                    onChange={(e) => set({ letterhead_align: e.target.value as 'left' | 'center' })}>
              <option value="left">Left, details on the right</option>
              <option value="center">Centred, details below</option>
            </select>
          </Field>
          <div className="crm-form-wide">
            <Field label="Tagline" hint="One line under the company name.">
              <input value={setup.tagline ?? ''} maxLength={160} placeholder="What your company does, in a line"
                     onChange={(e) => set({ tagline: e.target.value })} />
            </Field>
          </div>
          <Field label="CIN" hint="Company Identification Number, 21 characters.">
            <input value={setup.cin ?? ''} maxLength={21} placeholder="U72200MH2020PTC123456"
                   onChange={(e) => set({ cin: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="PAN">
            <input value={setup.pan ?? ''} maxLength={10} placeholder="AAACA1234B"
                   onChange={(e) => set({ pan: e.target.value.toUpperCase() })} />
          </Field>
        </div>
        <label className="crm-check">
          <input type="checkbox" checked={setup.show_gstin_in_header}
                 onChange={(e) => set({ show_gstin_in_header: e.target.checked })} />
          Show the GSTIN in the letterhead
        </label>
      </Card>

      <Card icon={<IconSheet size={16} />} title="Preview" hint="From the details on Basics. The logo prints where the mark is.">
        <div className={`qs-letterhead is-${setup.letterhead_align}`} style={{ ['--qs-accent' as string]: setup.accent_color }}>
          <div className="qs-lh-band">
            <span className="qs-lh-mark" aria-hidden>{(setup.company_name ?? 'C').slice(0, 1).toUpperCase()}</span>
            <div className="qs-lh-text">
              <strong>{setup.company_name || 'Your company name'}</strong>
              {setup.tagline && <span>{setup.tagline}</span>}
            </div>
          </div>
          <div className="qs-lh-lines">
            <span>{setup.address || 'Address from Basics'}</span>
            {contact && <span>{contact}</span>}
            {ids && <span>{ids}</span>}
          </div>
        </div>
      </Card>
    </div>
  )
}

/** Detailed / Proposal → Letter & terms: the covering letter, and the terms
 *  printed in their own sections after the price table. */
function LetterPanel({ setup, set }: { setup: QuotationSetup; set: SetFn }) {
  return (
    <div className="qs-columns">
      <Card icon={<IconMail size={16} />} title="Covering letter"
            hint="The first page of the proposal, addressed to the customer.">
        <p className="qs-tokens">
          Fill-ins:{' '}
          {LETTER_TOKENS.map((token) => <code key={token}>{token}</code>)}
        </p>
        <Field label="Subject">
          <input value={setup.letter_subject ?? ''} maxLength={200}
                 placeholder="Proposal for {company} — {number}"
                 onChange={(e) => set({ letter_subject: e.target.value })} />
        </Field>
        <Field label="Greeting">
          <input value={setup.letter_greeting ?? ''} maxLength={120} placeholder="Dear {customer},"
                 onChange={(e) => set({ letter_greeting: e.target.value })} />
        </Field>
        <Field label="Letter">
          <textarea rows={7} value={setup.letter_body ?? ''} maxLength={4000}
                    placeholder={'Thank you for the opportunity to propose our services. Based on our discussion, we are pleased to share the scope and pricing below.\n\nWe look forward to working with you.'}
                    onChange={(e) => set({ letter_body: e.target.value })} />
        </Field>
        <Field label="Closing" hint="The signatory and stamp from Basics print under it.">
          <input value={setup.letter_closing ?? ''} maxLength={120} placeholder="Warm regards,"
                 onChange={(e) => set({ letter_closing: e.target.value })} />
        </Field>
      </Card>

      <Card icon={<IconStar size={16} />} title="Proposal terms"
            hint="Each prints as its own section after the price table. The general terms on Basics still print too.">
        <Field label="Payment terms">
          <textarea rows={3} value={setup.payment_terms ?? ''}
                    placeholder="50% advance with the order, balance before delivery."
                    onChange={(e) => set({ payment_terms: e.target.value })} />
        </Field>
        <Field label="Delivery & timeline">
          <textarea rows={3} value={setup.delivery_terms ?? ''}
                    placeholder="Go-live within 15 working days of the advance."
                    onChange={(e) => set({ delivery_terms: e.target.value })} />
        </Field>
        <Field label="Warranty & support">
          <textarea rows={3} value={setup.warranty_terms ?? ''}
                    placeholder="12 months of support by phone and email, 10am–7pm, Monday to Saturday."
                    onChange={(e) => set({ warranty_terms: e.target.value })} />
        </Field>
      </Card>
    </div>
  )
}

function Card({ icon, title, hint, children }: { icon: ReactNode; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="card qs-card">
      <div className="qs-card-head">
        <span className="qs-card-icon" aria-hidden>{icon}</span>
        <h2>{title}</h2>
      </div>
      {hint && <p className="qs-card-hint">{hint}</p>}
      <div className="qs-card-body">{children}</div>
    </section>
  )
}

function Toggle({ label, hint, on, onChange, children }: {
  label: string; hint: string; on: boolean; onChange: (on: boolean) => void; children: ReactNode
}) {
  return (
    <div className={`qs-toggle${on ? ' is-on' : ''}`}>
      <div className="qs-toggle-head">
        <span>
          <strong>{label}</strong>
          <span>{hint}</span>
        </span>
        <button type="button" role="switch" aria-checked={on} aria-label={label}
                className="qs-switch" onClick={() => onChange(!on)}>
          <span />
        </button>
      </div>
      {on && <div className="qs-toggle-body">{children}</div>}
    </div>
  )
}

/** Shows the stored image and replaces or removes it on the spot. */
function ImageField({ kind, label, hint, present, version, onChange }: {
  kind: 'logo' | 'stamp'; label: string; hint: string; present: boolean
  version: string | null | undefined; onChange: () => void
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!present) {
      setSrc(null)
      return
    }
    let objectUrl: string | null = null
    let cancelled = false
    fetchImage(`/api/v1/crm/settings/quotation-images/${kind}?v=${encodeURIComponent(version ?? '')}`)
      .then((url) => {
        if (cancelled) return URL.revokeObjectURL(url)
        objectUrl = url
        setSrc(url)
      })
      .catch(() => !cancelled && setSrc(null))
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [kind, present, version])

  async function send(file: File) {
    setBusy(true)
    setFailure(null)
    try {
      const body = new FormData()
      body.append('file', file)
      await api.upload(`/crm/settings/quotation-images/${kind}`, body)
      onChange()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'That image could not be uploaded.')
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  async function remove() {
    setBusy(true)
    setFailure(null)
    try {
      await api.del(`/crm/settings/quotation-images/${kind}`)
      onChange()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'That image could not be removed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="qs-image">
      <span className="crm-field-label">{label}</span>
      <div className="qs-image-row">
        <div className="qs-image-box">{src ? <img src={src} alt={label} /> : <span>None</span>}</div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden
               onChange={(e) => { const file = e.target.files?.[0]; if (file) void send(file) }} />
        <button type="button" className="btn" onClick={() => input.current?.click()} disabled={busy}>
          <IconUpload size={15} /> {busy ? 'Uploading…' : present ? 'Replace' : 'Upload'}
        </button>
        {present && (
          <button type="button" className="link-btn" onClick={remove} disabled={busy}>
            Remove
          </button>
        )}
      </div>
      <span className="crm-field-hint">{hint}</span>
      {failure && <ErrorNote>{failure}</ErrorNote>}
    </div>
  )
}
