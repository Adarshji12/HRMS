/**
 * Deal details on the lead form, adding or editing.
 *
 * The same fields and the same record as the opportunity form: when any of them
 * is filled in, saving the lead also creates its opportunity, or updates the one
 * it has. Left empty, only the lead is saved. Expected revenue lives on the lead
 * form already and is passed in; email, phone and salesperson come from the lead.
 */

import { type KeyboardEvent, type ReactNode } from 'react'
import { IconBriefcase, IconClose, IconDownload, IconUpload } from '../../components/Icons'
import { api, download } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { crm, crmError, type Opportunity, type OpportunityFile, type OpportunityStage } from './api'
import { LfField, LfInput, LfSection, LostReasonSelect, MasterSelect } from './parts'

/** The chance of winning each stage stands for; choosing a stage fills it in. */
const STAGE_CHANCE: Record<OpportunityStage, number> = { qualified: 10, proposal: 40, commit: 80, won: 100, lost: 0 }

export interface Deal {
  /** Blank means "<lead> opportunity". */
  title: string
  lostReason: string
  stage: OpportunityStage
  probability: string
  closing: string
  customerId: string
  priority: number
  tags: string[]
  tagDraft: string
  requirementId: string
  oemId: string
  rawCost: string
  teamId: string
  mailSent: boolean
  approve: boolean
  notes: string
  files: Record<OpportunityFile, File | null>
  /** A stored file the person took off; it goes when the form saves. */
  removed: Record<OpportunityFile, boolean>
}

export const blankDeal = (): Deal => ({
  title: '', lostReason: '', stage: 'qualified',
  probability: '10', closing: '', customerId: '', priority: 0, tags: [], tagDraft: '', requirementId: '', oemId: '',
  rawCost: '', teamId: '', mailSent: false, approve: false, notes: '', files: { costsheet: null, quotation: null },
  removed: { costsheet: false, quotation: false },
})

/** The form's fields for an opportunity already saved. */
export const dealFromOpportunity = (o: Opportunity): Deal => ({
  ...blankDeal(),
  title: o.title,
  stage: o.stage,
  lostReason: o.lost_reason ?? '',
  probability: String(o.probability),
  closing: o.expected_closing ? o.expected_closing.slice(0, 10) : '',
  customerId: o.customer_id ?? '',
  priority: o.priority,
  tags: o.tags,
  requirementId: o.requirement_type_id ?? '',
  oemId: o.oem_id ?? '',
  rawCost: o.raw_cost ?? '',
  teamId: o.team_id ?? '',
  mailSent: o.is_mail_send,
  // Ticked means "sent for approval" or already decided; unticking withdraws it.
  approve: o.costsheet_status !== 'none',
  notes: o.notes ?? '',
})

const MAX_FILE = 15 * 1024 * 1024
const moneyOk = (v: string) => /^\d{1,12}(\.\d{1,2})?$/.test(v.trim())
const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

/** Has anything been entered that only an opportunity can hold? */
export function dealStarted(d: Deal): boolean {
  return Boolean(d.closing || d.customerId || d.tags.length || d.tagDraft.trim() || d.requirementId
    || d.oemId || d.rawCost.trim() || d.teamId || d.mailSent || d.approve || d.notes.trim()
    || d.files.costsheet || d.files.quotation)
}

const probabilityBad = (d: Deal) => d.probability.trim() === '' || Number(d.probability) > 100
const costBad = (d: Deal) => d.rawCost.trim() !== '' && !moneyOk(d.rawCost)

/** Nothing here is required until a deal is started; then it needs a value and a
 *  date. A deal already saved may have no date, and that must not stop the lead
 *  being edited. */
export function dealBlocked(d: Deal, revenue: string, saved = false): boolean {
  if (saved) return !revenue.trim() || probabilityBad(d) || costBad(d)
  if (!dealStarted(d)) return false
  return !revenue.trim() || !d.closing || probabilityBad(d) || costBad(d)
}

/** Create or update the lead's opportunity. Returns the id, so a retry after a
 *  failed upload does not create a second opportunity. */
export async function saveDeal(
  leadId: string, leadName: string, revenue: string, d: Deal, existingId: string | null, title?: string,
): Promise<string> {
  const body = {
    title: d.title.trim() || title || `${leadName} opportunity`,
    stage: d.stage,
    lost_reason: d.stage === 'lost' ? d.lostReason.trim() || null : null,
    customer_id: d.customerId || null,
    expected_revenue: revenue.trim(),
    probability: Number(d.probability),
    expected_closing: d.closing || null,
    priority: d.priority,
    tags: d.tagDraft.trim() ? [...d.tags, d.tagDraft.trim()] : d.tags,
    requirement_type_id: d.requirementId || null,
    oem_id: d.oemId || null,
    raw_cost: d.rawCost.trim() || null,
    team_id: d.teamId || null,
    is_mail_send: d.mailSent,
    send_costsheet_for_approval: d.approve,
    notes: d.notes.trim() || null,
  }
  const id = existingId ?? (await crm.createOpportunity(leadId, body)).id
  if (existingId) await crm.updateOpportunity(existingId, body)
  return id
}

export async function uploadDealFiles(id: string, d: Deal, saved?: Opportunity | null) {
  for (const which of ['costsheet', 'quotation'] as OpportunityFile[]) {
    const file = d.files[which]
    if (!file && !(d.removed[which] && saved?.[which])) continue
    try {
      if (file) await crm.uploadOpportunityFile(id, which, file)
      else await crm.removeOpportunityFile(id, which)
    } catch (err) {
      throw new Error(`The lead is saved, but the ${which} could not be uploaded. ${crmError(err, '')}`.trim())
    }
  }
}

export type FieldMode = 'show' | 'mandatory' | 'hide'

export function LeadDealFields({ deal, onChange, revenue, saved, part = 'both', all, leading, fm }: {
  deal: Deal
  onChange: (d: Deal) => void
  revenue: string
  /** Which half to show: the deal itself, the opportunity details, or both. */
  part?: 'deal' | 'opportunity' | 'both'
  /** Editing a lead: every field is required, not only the ones a started deal needs. */
  all?: boolean
  /** The opportunity being edited, when the lead already has one. */
  saved?: Opportunity | null
  /** A field the lead form owns (Expected revenue), shown first in the opportunity details. */
  leading?: ReactNode
  /** How this person has set each field: shown, mandatory or hidden. */
  fm?: (key: string) => FieldMode
}) {
  const hid = (k: string) => fm?.(k) === 'hide'
  const need = (k: string) => Boolean(all) || fm?.(k) === 'mandatory'
  const set = (patch: Partial<Deal>) => onChange({ ...deal, ...patch })
  const teams = useQuery<Array<{ id: string; name: string; is_active: boolean }>>('teams', () => api.get('/org/teams'))
  const customers = useQuery('crm-customers-for-opportunity', () => crm.customers({}))
  const started = dealStarted(deal)
  const req = Boolean(all)
  const showDeal = part !== 'opportunity'
  const showOpp = part !== 'deal'

  const revenueNumber = Number(revenue)
  const cost = deal.rawCost.trim() && moneyOk(deal.rawCost) ? Number(deal.rawCost) : null
  const margin = cost === null || !revenue.trim() || Number.isNaN(revenueNumber) ? null : revenueNumber - cost
  const marginPercent = margin !== null && revenueNumber > 0 ? (margin / revenueNumber) * 100 : null

  function addTag(raw: string) {
    const text = raw.trim()
    const tags = text && !deal.tags.some((t) => t.toLowerCase() === text.toLowerCase()) ? [...deal.tags, text] : deal.tags
    set({ tags, tagDraft: '' })
  }
  function onTagKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      addTag(deal.tagDraft)
    } else if (event.key === 'Backspace' && !deal.tagDraft && deal.tags.length > 0) {
      set({ tags: deal.tags.slice(0, -1) })
    }
  }
  const tooBig = (file: File | null) => Boolean(file && file.size > MAX_FILE)

  return (
    <>
    {showDeal && <LfSection icon={<IconBriefcase size={16} />} title="Deal details"
               note={saved ? 'Saved on this lead\'s opportunity.' : 'Optional. Fill these in to create the opportunity with the lead.'}>
      <LfField label="Probability" required error={probabilityBad(deal) ? 'Between 0 and 100.' : undefined}>
        <LfInput prefix="%" bad={probabilityBad(deal)}>
          <input value={deal.probability} type="number" data-spin min={0} step={1} placeholder="e.g. 30" aria-label="Probability"
                 onChange={(e) => set({ probability: e.target.value.replace(/\D/g, '').slice(0, 3) })} />
        </LfInput>
      </LfField>
      {!hid('closing') && <LfField label="Expected closing" required={req || (started && !saved)}
               error={(req || (started && !saved)) && !deal.closing ? 'Needed once deal details are filled in.' : undefined}>
        <input type="date" value={deal.closing} aria-label="Expected closing" onChange={(e) => set({ closing: e.target.value })} />
      </LfField>}

      {!hid('customer') && <LfField label="Existing customer" required={need('customer')} hint="Only if this deal is for a customer you already have.">
        <select value={deal.customerId} aria-label="Existing customer" onChange={(e) => set({ customerId: e.target.value })}>
          <option value="">Select customer</option>
          {(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.company ? ` · ${c.company}` : ''}</option>)}
        </select>
      </LfField>}
      <LfField label="Currency" hint="All amounts are in rupees.">
        <input value="INR (₹)" readOnly disabled className="lf-readonly" aria-label="Currency" />
      </LfField>

      {!hid('tags') && <LfField label="Tags" required={need('tags')} wide hint="Press Enter or comma after each tag.">
        <div className="opp-tags">
          {deal.tags.map((tag) => (
            <span className="opp-tag" key={tag}>
              {tag}
              <button type="button" aria-label={`Remove ${tag}`} onClick={() => set({ tags: deal.tags.filter((t) => t !== tag) })}>
                <IconClose size={11} />
              </button>
            </span>
          ))}
          <input value={deal.tagDraft} onChange={(e) => set({ tagDraft: e.target.value })} onKeyDown={onTagKey}
                 onBlur={() => addTag(deal.tagDraft)} placeholder={deal.tags.length ? '' : 'e.g. Hardware, Urgent'} maxLength={40} aria-label="Tags" />
        </div>
      </LfField>}
    </LfSection>}

    {showOpp && <LfSection icon={<IconBriefcase size={16} />} title="Opportunity"
               note={saved ? 'Saved on this opportunity.' : 'Optional. Requirement, cost, files and notes for this opportunity.'}>
      {!hid('title') && <LfField label="Opportunity name" required={need('title')} wide>
        <input value={deal.title} maxLength={200} aria-label="Opportunity name" placeholder="e.g. 20 desktops for the accounts team"
               onChange={(e) => set({ title: e.target.value })} />
      </LfField>}
      <LfField label="Stage">
        <select value={deal.stage} aria-label="Opportunity stage" onChange={(e) => { const stage = e.target.value as OpportunityStage; set({ stage, probability: String(STAGE_CHANCE[stage]) }) }}>
          <option value="qualified">Qualified</option>
          <option value="proposal">Proposal</option>
          <option value="commit">Commit</option>
          <option value="won">Won</option>
          <option value="lost">Lost</option>
        </select>
      </LfField>
      {leading}
      {deal.stage === 'lost' && (
        <LfField label="Reason lost" required>
          <LostReasonSelect value={deal.lostReason} onChange={(v) => set({ lostReason: v })} />
        </LfField>
      )}
      {!hid('requirement') && <LfField label="Requirement type" required={need('requirement')}>
        <MasterSelect kind="requirement-types" value={deal.requirementId} onChange={(v) => set({ requirementId: v })} placeholder="Select requirement type" />
      </LfField>}
      {!hid('oem') && <LfField label="OEM" required={need('oem')}>
        <MasterSelect kind="item-companies" value={deal.oemId} onChange={(v) => set({ oemId: v })} placeholder="Select OEM" />
      </LfField>}

      {!hid('raw_cost') && <LfField label="Raw cost" required={need('raw_cost')} error={costBad(deal) ? 'Enter an amount like 200000 or 200000.50.' : undefined}>
        <LfInput prefix="₹" bad={costBad(deal)}>
          <input value={deal.rawCost} type="number" data-spin min={0} step="any" placeholder="e.g. 200000" aria-label="Raw cost"
                 onChange={(e) => set({ rawCost: e.target.value.replace(/,/g, '') })} />
        </LfInput>
      </LfField>}
      {!hid('team') && <LfField label="Sales team" required={need('team')}>
        <select value={deal.teamId} aria-label="Sales team" onChange={(e) => set({ teamId: e.target.value })}>
          <option value="">Select sales team</option>
          {(teams.data ?? []).filter((t) => t.is_active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </LfField>}

      <LfField label="Margin" hint="Expected revenue less raw cost.">
        <input value={margin === null ? '' : rupees(margin)} readOnly tabIndex={-1} className="lf-readonly" placeholder="Worked out from the cost" aria-label="Margin" />
      </LfField>
      <LfField label="Margin %">
        <input value={marginPercent === null ? '' : `${marginPercent.toFixed(2)}%`} readOnly tabIndex={-1} className="lf-readonly" placeholder="Worked out from the cost" aria-label="Margin percent" />
      </LfField>

      {(['costsheet', 'quotation'] as OpportunityFile[]).filter((w) => !hid(w)).map((which) => {
        const file = deal.files[which]
        const label = which === 'costsheet' ? 'Costsheet' : 'Quotation'
        const stored = !file && !deal.removed[which] ? saved?.[which] : null
        const status = saved && deal.approve ? saved.costsheet_status : 'none'
        return (
          <LfField key={which} label={label} required={need(which)} error={tooBig(file) ? 'That file is larger than 15 MB.' : undefined}
                   hint={file || stored ? undefined : 'Up to 15 MB.'}>
            <div className="opp-file">
              <label className="btn btn-sm">
                <IconUpload size={14} /> {file || stored ? 'Replace file' : 'Upload your file'}
                <input type="file" hidden aria-label={`${label} file`} onChange={(e) => {
                  const next = e.target.files?.[0] ?? null
                  set({
                    files: { ...deal.files, [which]: next },
                    removed: next ? { ...deal.removed, [which]: false } : deal.removed,
                  })
                  e.target.value = ''
                }} />
              </label>
              {which === 'costsheet' && (
                <label className="crm-check opp-approve" title="Sends the costsheet to the Costsheet tab on the Approvals page, where a manager approves or rejects it">
                  <input type="checkbox" checked={deal.approve} onChange={(e) => set({ approve: e.target.checked })} /> Approve
                  {status !== 'none' && (
                    <span className={`opp-decision is-${status}`}>
                      {status === 'pending' ? 'Pending' : status === 'approved' ? 'Approved' : 'Rejected'}
                    </span>
                  )}
                </label>
              )}
              {file && (
                <span className="opp-file-name" title={file.name}>
                  {file.name}
                  <button type="button" aria-label={`Remove ${label.toLowerCase()}`} onClick={() => set({ files: { ...deal.files, [which]: null } })}>
                    <IconClose size={12} />
                  </button>
                </span>
              )}
              {stored && saved && (
                <span className="opp-file-name" title={stored.name}>
                  {stored.name}
                  <button type="button" aria-label={`Download ${label.toLowerCase()}`}
                          onClick={() => void download(`/crm/opportunities/${saved.id}/files/${which}`, stored.name)}>
                    <IconDownload size={14} />
                  </button>
                  <button type="button" aria-label={`Remove ${label.toLowerCase()}`}
                          onClick={() => set({ removed: { ...deal.removed, [which]: true } })}>
                    <IconClose size={12} />
                  </button>
                </span>
              )}
            </div>
          </LfField>
        )
      })}

      {!hid('mail') && <LfField label="Mail">
        <label className="crm-check">
          <input type="checkbox" checked={deal.mailSent} onChange={(e) => set({ mailSent: e.target.checked })} /> Mail sent to the customer
        </label>
      </LfField>}
      {!hid('notes') && <LfField label="Internal notes" wide required={need('notes')}>
        <textarea value={deal.notes} onChange={(e) => set({ notes: e.target.value })} rows={3} maxLength={4000}
                  placeholder="Anything the team should know about this deal" />
      </LfField>}
    </LfSection>}
    </>
  )
}

/** Editing: what is still empty. Every field but the two tick boxes is required. */
export function dealIncomplete(d: Deal, saved?: Opportunity | null, fm?: (key: string) => FieldMode): boolean {
  const hasFile = (which: OpportunityFile) => Boolean(d.files[which] || (saved?.[which] && !d.removed[which]))
  const on = (k: string) => fm?.(k) !== 'hide'
  return (on('title') && !d.title.trim()) || (on('closing') && !d.closing) || (on('customer') && !d.customerId)
    || (on('tags') && d.tags.length === 0 && !d.tagDraft.trim())
    || (on('requirement') && !d.requirementId) || (on('oem') && !d.oemId) || (on('raw_cost') && !d.rawCost.trim())
    || (on('team') && !d.teamId) || (on('notes') && !d.notes.trim())
    || (on('costsheet') && !hasFile('costsheet')) || (on('quotation') && !hasFile('quotation'))
}

/** Which deal fields the person made mandatory are still empty. `deal` = the Deal
 *  details step, `opportunity` = the Opportunity step. */
export function dealMandatoryMissing(
  d: Deal, fm: (key: string) => FieldMode, saved?: Opportunity | null,
): { deal: boolean; opportunity: boolean } {
  const hasFile = (which: OpportunityFile) => Boolean(d.files[which] || (saved?.[which] && !d.removed[which]))
  const empty: Record<string, boolean> = {
    customer: !d.customerId, tags: d.tags.length === 0 && !d.tagDraft.trim(),
    title: !d.title.trim(), requirement: !d.requirementId, oem: !d.oemId, raw_cost: !d.rawCost.trim(),
    team: !d.teamId, costsheet: !hasFile('costsheet'), quotation: !hasFile('quotation'), notes: !d.notes.trim(),
  }
  const bad = (k: string) => fm(k) === 'mandatory' && empty[k]
  return { deal: ['customer', 'tags'].some(bad), opportunity: ['title', 'requirement', 'oem', 'raw_cost', 'team', 'costsheet', 'quotation', 'notes'].some(bad) }
}

/** Any file too large to upload — blocks saving rather than failing after the lead exists. */
export const dealFilesTooBig = (d: Deal) => [d.files.costsheet, d.files.quotation].some((f) => f && f.size > MAX_FILE)
