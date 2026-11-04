/**
 * The opportunity form: the deal a lead turns into.
 *
 * Opens straight after a new lead is saved, and from the lead's own page. What
 * is not asked here is already known from the lead — customer, email, phone and
 * the salesperson (the lead's owner) — and the currency, because a workspace
 * sells in one.
 *
 * Revenue, cost and margin are in rupees. The margin shown is worked out as the
 * person types; the server works it out again on the way out, and that is the
 * figure a list shows.
 */

import { useState, type KeyboardEvent } from 'react'
import { ErrorNote } from '../../components/ui'
import { IconClose, IconDownload, IconStar, IconTrash, IconUpload } from '../../components/Icons'
import { api, download } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import {
  crm,
  crmError,
  type Lead,
  type Opportunity,
  type OpportunityFile,
  type OpportunityInput,
} from './api'
import { Dialog, Field, MasterSelect } from './parts'

const FILES: Array<{ which: OpportunityFile; label: string }> = [
  { which: 'costsheet', label: 'Costsheet' },
  { which: 'quotation', label: 'Quotation' },
]

const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

export function OpportunityForm({
  lead,
  opportunity,
  onClose,
  onSaved,
}: {
  lead: Lead
  /** Given to edit one; left out to start a new one for the lead. */
  opportunity?: Opportunity | null
  onClose: () => void
  onSaved: () => void
}) {
  const [savedId, setSavedId] = useState<string | null>(opportunity?.id ?? null)
  const [title, setTitle] = useState(opportunity?.title ?? `${lead.name} opportunity`)
  const [customerId, setCustomerId] = useState(opportunity?.customer_id ?? '')
  const [revenue, setRevenue] = useState(opportunity ? opportunity.expected_revenue : '')
  const [probability, setProbability] = useState(String(opportunity?.probability ?? 10))
  const [closing, setClosing] = useState(opportunity?.expected_closing ?? '')
  const [priority, setPriority] = useState(opportunity?.priority ?? 0)
  const [tags, setTags] = useState<string[]>(opportunity?.tags ?? [])
  const [tagDraft, setTagDraft] = useState('')
  const [requirementId, setRequirementId] = useState(opportunity?.requirement_type_id ?? '')
  const [oemId, setOemId] = useState(opportunity?.oem_id ?? '')
  const [rawCost, setRawCost] = useState(opportunity?.raw_cost ?? '')
  const [teamId, setTeamId] = useState(opportunity?.team_id ?? '')
  const [mailSent, setMailSent] = useState(opportunity?.is_mail_send ?? false)
  // Ticked means "sent for approval" — or already decided, which the status beside it says.
  const [sendForApproval, setSendForApproval] = useState((opportunity?.costsheet_status ?? 'none') !== 'none')
  const [notes, setNotes] = useState(opportunity?.notes ?? '')

  // A file is chosen now and uploaded once the opportunity exists. What is
  // already stored is shown until it is removed or replaced.
  const [picked, setPicked] = useState<Record<OpportunityFile, File | null>>({ costsheet: null, quotation: null })
  const [stored, setStored] = useState<Record<OpportunityFile, Opportunity['costsheet']>>({
    costsheet: opportunity?.costsheet ?? null,
    quotation: opportunity?.quotation ?? null,
  })
  const [removed, setRemoved] = useState<Record<OpportunityFile, boolean>>({ costsheet: false, quotation: false })

  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const teams = useQuery<Array<{ id: string; name: string; is_active: boolean }>>(
    'teams',
    () => api.get('/org/teams'),
  )

  // Only the customers this person may see: the list is scoped like My Customers.
  const customers = useQuery('crm-customers-for-opportunity', () => crm.customers({}))

  const revenueNumber = Number(revenue)
  const costNumber = rawCost === '' ? null : Number(rawCost)
  const margin = costNumber === null || Number.isNaN(costNumber) || Number.isNaN(revenueNumber)
    ? null
    : revenueNumber - costNumber
  const marginPercent = margin !== null && revenueNumber > 0 ? (margin / revenueNumber) * 100 : null

  const probabilityNumber = Number(probability)
  const probabilityBad = probability.trim() === '' || !(probabilityNumber >= 0 && probabilityNumber <= 100)
  const revenueBad = revenue.trim() === '' || !(revenueNumber >= 0)
  const costBad = rawCost !== '' && !(costNumber !== null && costNumber >= 0)
  const problem = !title.trim()
    ? 'Give the opportunity a name.'
    : revenueBad
      ? 'Enter the expected revenue.'
      : probabilityBad
        ? 'Probability must be between 0 and 100.'
        : !closing
          ? 'Choose the expected closing date.'
          : costBad
            ? 'Raw cost must be a number.'
            : null

  function addTag(raw: string) {
    const text = raw.trim()
    if (text && !tags.some((t) => t.toLowerCase() === text.toLowerCase())) setTags([...tags, text])
    setTagDraft('')
  }
  function onTagKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      addTag(tagDraft)
    } else if (event.key === 'Backspace' && !tagDraft && tags.length > 0) {
      setTags(tags.slice(0, -1))
    }
  }

  async function submit() {
    setTouched(true)
    if (problem) {
      setError(problem)
      return
    }
    setSaving(true)
    setError(null)
    const body: OpportunityInput = {
      title: title.trim(),
      customer_id: customerId || null,
      expected_revenue: revenue,
      probability: probabilityNumber,
      expected_closing: closing || null,
      priority,
      tags: tagDraft.trim() ? [...tags, tagDraft.trim()] : tags,
      requirement_type_id: requirementId || null,
      oem_id: oemId || null,
      raw_cost: rawCost === '' ? null : rawCost,
      team_id: teamId || null,
      is_mail_send: mailSent,
      send_costsheet_for_approval: sendForApproval,
      notes: notes.trim() || null,
    }
    let id = savedId
    try {
      // Once saved, a retry after a failed upload updates rather than duplicates.
      const row = id ? await crm.updateOpportunity(id, body) : await crm.createOpportunity(lead.id, body)
      id = row.id
      setSavedId(id)
    } catch (err) {
      setError(crmError(err, 'That opportunity could not be saved'))
      setSaving(false)
      return
    }
    try {
      for (const { which, label } of FILES) {
        const file = picked[which]
        try {
          if (file) {
            await crm.uploadOpportunityFile(id, which, file)
            setPicked((current) => ({ ...current, [which]: null }))
          } else if (removed[which] && stored[which]) {
            await crm.removeOpportunityFile(id, which)
            setStored((current) => ({ ...current, [which]: null }))
          }
        } catch (err) {
          throw new Error(`Saved, but the ${label.toLowerCase()} could not be uploaded. ${crmError(err, '')}`.trim())
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'A file could not be uploaded')
      setSaving(false)
      return
    }
    onSaved()
  }

  async function remove() {
    if (!savedId) return
    if (!window.confirm('Delete this opportunity? This cannot be undone.')) return
    setSaving(true)
    try {
      await crm.deleteOpportunity(savedId)
      onSaved()
    } catch (err) {
      setError(crmError(err, 'That opportunity could not be deleted'))
      setSaving(false)
    }
  }

  const showError = (bad: boolean) => touched && bad

  return (
    <Dialog
      wide
      title={savedId ? 'Edit opportunity' : 'New opportunity'}
      subtitle={
        <>
          For <strong>{lead.name}</strong> · {lead.mobile}
          {lead.owner_name ? <> · salesperson {lead.owner_name}</> : null}
        </>
      }
      onClose={onClose}
      footer={
        <>
          <span className="lf-foot-note"><span className="lf-req">*</span> Required fields</span>
          {savedId && (
            <button className="btn btn-danger" type="button" onClick={remove} disabled={saving}>
              <IconTrash size={15} /> Delete
            </button>
          )}
          {savedId && (
            <button className="btn" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
          )}
          <button className="btn btn-primary" type="button" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="crm-form">
        {error && (
          <div className="crm-form-wide">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        <Field label="Opportunity" wide required>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200}
                 placeholder="e.g. 20 desktops for the accounts team" autoFocus
                 aria-invalid={showError(!title.trim())} />
        </Field>

        <Field label="Customer" hint="Only if this deal is for an existing customer.">
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Select customer</option>
            {(customers.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{c.company ? ` · ${c.company}` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tags" hint="Press Enter or comma after each tag.">
          <div className="opp-tags">
            {tags.map((tag) => (
              <span className="opp-tag" key={tag}>
                {tag}
                <button type="button" aria-label={`Remove ${tag}`} onClick={() => setTags(tags.filter((t) => t !== tag))}>
                  <IconClose size={11} />
                </button>
              </span>
            ))}
            <input value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} onKeyDown={onTagKey}
                   onBlur={() => addTag(tagDraft)} placeholder={tags.length ? '' : 'e.g. Hardware, Urgent'}
                   maxLength={40} />
          </div>
        </Field>

        <Field label="Expected revenue (₹)" required>
          <input value={revenue} onChange={(e) => setRevenue(e.target.value)} inputMode="decimal"
                 placeholder="e.g. 250000" aria-invalid={showError(revenueBad)} />
        </Field>
        <Field label="Probability (%)" required>
          <input value={probability} onChange={(e) => setProbability(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
                 inputMode="numeric" placeholder="e.g. 30" aria-invalid={showError(probabilityBad)} />
        </Field>

        <Field label="Expected closing" required>
          <input type="date" value={closing} onChange={(e) => setClosing(e.target.value)}
                 aria-invalid={showError(!closing)} />
        </Field>
        <Field label="Priority">
          <div className="opp-stars" role="radiogroup" aria-label="Priority">
            {[1, 2, 3].map((n) => (
              <button key={n} type="button" role="radio" aria-checked={priority === n}
                      className={n <= priority ? 'is-on' : undefined}
                      aria-label={`${n} star${n === 1 ? '' : 's'}`}
                      onClick={() => setPriority(priority === n ? 0 : n)}>
                <IconStar size={20} />
              </button>
            ))}
          </div>
        </Field>

        <Field label="Requirement type">
          <MasterSelect kind="requirement-types" value={requirementId} onChange={setRequirementId}
                        placeholder="Select requirement type" />
        </Field>
        <Field label="OEM">
          <MasterSelect kind="item-companies" value={oemId} onChange={setOemId} placeholder="Select OEM" />
        </Field>


        <Field label="Raw cost (₹)" hint={costBad ? <span className="lf-req">Enter a number.</span> : undefined}>
          <input value={rawCost} onChange={(e) => setRawCost(e.target.value)} inputMode="decimal"
                 placeholder="e.g. 200000" aria-invalid={costBad} />
        </Field>
        <Field label="Sales team">
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">Select sales team</option>
            {(teams.data ?? []).filter((t) => t.is_active || t.id === teamId).map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </Field>

        <Field label="Margin (₹)" hint="Revenue less raw cost.">
          <input value={margin === null ? '' : rupees(margin)} readOnly tabIndex={-1} placeholder="Worked out from the cost" />
        </Field>
        <Field label="Margin (%)">
          <input value={marginPercent === null ? '' : `${marginPercent.toFixed(2)}%`} readOnly tabIndex={-1}
                 placeholder="Worked out from the cost" />
        </Field>

        {FILES.map(({ which, label }) => {
          const current = picked[which] ?? (removed[which] ? null : stored[which])
          const name = picked[which]?.name ?? current?.name
          return (
            <div className="crm-field" key={which}>
              <span className="crm-field-label">{label}</span>
              <div className="opp-file">
                <label className="btn btn-sm">
                  <IconUpload size={14} /> {name ? 'Replace file' : 'Upload your file'}
                  <input type="file" hidden onChange={(e) => {
                    const file = e.target.files?.[0] ?? null
                    setPicked((c) => ({ ...c, [which]: file }))
                    if (file) setRemoved((c) => ({ ...c, [which]: false }))
                    e.target.value = ''
                  }} />
                </label>
                {/* Approval sits beside the button, on the costsheet only. */}
                {which === 'costsheet' && (
                  <label className="crm-check opp-approve"
                         title="Sends the costsheet to the Costsheet Approval tab, where a manager approves or rejects it">
                    <input type="checkbox" checked={sendForApproval}
                           onChange={(e) => setSendForApproval(e.target.checked)} />
                    Approve
                    {sendForApproval && opportunity && opportunity.costsheet_status !== 'none' && (
                      <span className={`opp-decision is-${opportunity.costsheet_status}`}>
                        {opportunity.costsheet_status === 'pending' ? 'Pending'
                          : opportunity.costsheet_status === 'approved' ? 'Approved' : 'Rejected'}
                      </span>
                    )}
                  </label>
                )}
                {name && (
                  <span className="opp-file-name" title={name}>
                    {name}
                    {!picked[which] && savedId && (
                      <button type="button" aria-label={`Download ${label.toLowerCase()}`}
                              onClick={() => void download(`/crm/opportunities/${savedId}/files/${which}`, name)}>
                        <IconDownload size={14} />
                      </button>
                    )}
                    <button type="button" aria-label={`Remove ${label.toLowerCase()}`}
                            onClick={() => {
                              setPicked((c) => ({ ...c, [which]: null }))
                              setRemoved((c) => ({ ...c, [which]: true }))
                            }}>
                      <IconClose size={12} />
                    </button>
                  </span>
                )}
              </div>
              <span className="crm-field-hint">Up to 15 MB.</span>
            </div>
          )
        })}

        <div className="crm-field crm-form-wide">
          <label className="crm-check">
            <input type="checkbox" checked={mailSent} onChange={(e) => setMailSent(e.target.checked)} />
            Mail sent to the customer
          </label>
        </div>

        <Field label="Internal notes" wide>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={4000}
                    placeholder="Anything the team should know about this deal" />
        </Field>
      </div>
    </Dialog>
  )
}
