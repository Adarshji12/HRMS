/* CRM data layer — the types every CRM page shares, and the small helpers that
   would otherwise be re-derived on nine screens.

   Page-local rather than in `lib/types.ts`, the same shape Assets and Timesheets
   use: `lib/types.ts` is lead-owned and does not carry module contracts. These
   mirror `app/schemas/crm.py` exactly; when one changes, both change.

   Money arrives as a **decimal string** ("21240.00"), not paise. That is
   deliberate on the server side — the arithmetic is done in Decimal and the
   string is what it produced — so `lib/format.money` (which takes paise) is the
   wrong tool here and `rupees()` below is the right one. Never parse one of
   these into a float and add it to another; ask the server for the total. */

import { api, ApiError } from '../../lib/api'

/* ------------------------------------------------------------------ types --- */

export interface Master {
  id: string
  name: string
  is_active: boolean
}

export interface LeadStatus extends Master {
  behaviour: 'default' | 'in_progress' | 'won' | 'lost'
  colour: string
  sort_order: number
  lead_count: number
}

export interface LeadSource extends Master {
  is_intake_default: boolean
}

export interface Country extends Master {
  iso2: string | null
  dial_code: string | null
}

export interface StateRow extends Master {
  country_id: string
  country_name: string | null
  gst_code: string | null
}

export interface CityRow extends Master {
  state_id: string
  state_name: string | null
  country_id: string | null
}

export interface Product extends Master {
  description: string | null
  hsn_sac: string | null
  unit: string | null
  rate: string
  gst_percent: string
  plan_count: number
}

export interface PlanRow extends Master {
  product_id: string
  product_name: string | null
  duration_days: number | null
  price: string
  gst_percent: string | null
}

export interface Disposition extends Master {
  closes_interaction: boolean
  sort_order: number
}

export interface VisitType extends Master {
  colour: string
  requires_otp: boolean
  sort_order: number
}

export interface Lead {
  id: string
  code: string
  name: string
  company: string | null
  mobile: string
  whatsapp: string | null
  email: string | null
  status_id: string | null
  status_name: string | null
  status_colour: string | null
  status_behaviour: string | null
  source_id: string | null
  source_name: string | null
  industry_id: string | null
  industry_name: string | null
  product_id: string | null
  product_name: string | null
  owner_id: string | null
  owner_name: string | null
  state_id: string | null
  state_name: string | null
  city_id: string | null
  city_name: string | null
  pincode: string | null
  address: string | null
  notes: string | null
  value: string | null
  next_follow_up_at: string | null
  last_contacted_at: string | null
  customer_id: string | null
  converted_at: string | null
  lost_reason: string | null
  created_at: string
  updated_at: string
}

export interface LeadPage {
  rows: Lead[]
  total: number
  page: number
  page_size: number
}

export interface Activity {
  id: string
  kind: string
  body: string
  actor_id: string | null
  actor_name: string | null
  created_at: string
}

export interface FollowUp {
  id: string
  lead_id: string | null
  customer_id: string | null
  subject_name: string | null
  subject_mobile: string | null
  subject_kind: 'lead' | 'customer'
  owner_id: string | null
  owner_name: string | null
  due_at: string
  purpose: string | null
  notes: string | null
  status: 'pending' | 'done' | 'cancelled'
  outcome: string | null
  completed_at: string | null
  created_at: string
  is_overdue: boolean
}

export interface LeadDetail extends Lead {
  activities: Activity[]
  follow_ups: FollowUp[]
  quotations: QuotationRow[]
}

export interface CustomerPlan {
  id: string
  customer_id: string
  product_id: string | null
  plan_id: string | null
  product_name: string
  plan_name: string | null
  start_on: string
  end_on: string | null
  renewal_on: string | null
  amount: string
  payment_status: 'pending' | 'partial' | 'paid'
  status: 'active' | 'expired' | 'cancelled'
  notes: string | null
  days_to_renewal: number | null
}

export interface Customer {
  id: string
  code: string
  name: string
  company: string | null
  mobile: string
  whatsapp: string | null
  email: string | null
  customer_type: string | null
  industry_id: string | null
  industry_name: string | null
  source_id: string | null
  source_name: string | null
  gstin: string | null
  country_id: string | null
  state_id: string | null
  state_name: string | null
  city_id: string | null
  city_name: string | null
  pincode: string | null
  address: string | null
  manager_id: string | null
  manager_name: string | null
  status: 'active' | 'on_hold' | 'expired' | 'churned'
  notes: string | null
  converted_from_lead_id: string | null
  created_at: string
  primary_plan: CustomerPlan | null
  plan_count: number
}

export interface Interaction {
  id: string
  ticket_no: string
  customer_id: string
  customer_name: string | null
  direction: 'inbound' | 'outbound'
  disposition_id: string | null
  disposition_name: string | null
  status: 'open' | 'closed'
  remarks: string | null
  staff_id: string | null
  staff_name: string | null
  follow_up_id: string | null
  follow_up_due_at: string | null
  closed_at: string | null
  created_at: string
}

export interface Visit {
  id: string
  visit_no: string
  customer_id: string | null
  lead_id: string | null
  /** Who the visit is for. `customer_name` / `customer_mobile` hold that
   *  lead's or customer's name and number either way. */
  subject_kind: 'lead' | 'customer'
  customer_name: string | null
  customer_mobile: string | null
  visit_type_id: string | null
  visit_type_name: string | null
  contact_person: string | null
  mobile: string | null
  address: string | null
  priority: 'low' | 'medium' | 'high' | 'urgent'
  purpose: string | null
  notes: string | null
  assigned_to: string | null
  employee_name: string | null
  scheduled_at: string
  started_at: string | null
  completed_at: string | null
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled'
  outcome: string | null
  duration_minutes: number | null
  otp_required: boolean
  otp_verified: boolean
  created_at: string
}

export interface CustomerDetail extends Customer {
  plans: CustomerPlan[]
  interactions: Interaction[]
  visits: Visit[]
}

export interface QuotationLine {
  id?: string
  product_id: string | null
  plan_id: string | null
  name: string
  description: string | null
  hsn_sac: string | null
  quantity: string
  rate: string
  discount: string
  discount_is_percent: boolean
  gst_percent: string
  taxable_value?: string
  tax_amount?: string
  amount?: string
  sort_order?: number
}

export type QuotationStatus =
  | 'draft' | 'sent' | 'failed' | 'accepted' | 'rejected' | 'expired'

export interface QuotationRow {
  id: string
  number: string
  customer_name: string | null
  company: string | null
  quote_date: string
  valid_until: string | null
  status: QuotationStatus
  grand_total: string
  created_by: string | null
  created_by_name: string | null
  lead_id: string | null
  customer_id: string | null
  created_at: string
}

export interface Quotation extends QuotationRow {
  gstin: string | null
  mobile: string | null
  whatsapp: string | null
  email: string | null
  city: string | null
  state: string | null
  pincode: string | null
  billing_address: string | null
  shipping_address: string | null
  sub_total: string
  discount_total: string
  taxable_value: string
  cgst: string
  sgst: string
  igst: string
  is_interstate: boolean
  terms: string | null
  notes: string | null
  sent_at: string | null
  decided_at: string | null
  lines: QuotationLine[]
}

export interface ReminderRecipient {
  id?: string
  name: string | null
  mobile: string
}

export interface Reminder {
  id: string
  name: string
  message: string | null
  image_url: string | null
  template_name: string | null
  audience: 'list' | 'leads' | 'customers'
  audience_filter: Record<string, unknown>
  start_on: string
  end_on: string | null
  send_time: string
  weekdays: number[]
  is_active: boolean
  last_run_on: string | null
  created_at: string
  recipient_count: number
  scheduled_sends: number
  recipients: ReminderRecipient[]
}

export interface ReminderRun {
  id: string
  reminder_id: string
  reminder_name: string | null
  run_on: string
  recipients: number
  sent: number
  failed: number
  note: string | null
  created_at: string
}

export interface CrmSettings {
  assignment_rule: 'unassigned' | 'fixed' | 'round_robin'
  default_owner_id: string | null
  assignment_pool: string[]
  intake_enabled: boolean
  intake_url: string | null
  quotation_prefix: string
  quotation_terms: string | null
  quotation_validity_days: number
  quotation_setup: QuotationSetup
  /** What the next quotation dated today would be numbered. */
  quotation_next_number: string
  visit_prefix: string
  ticket_prefix: string
  renewal_window_days: number
  reminders_enabled: boolean
}

/** CRM Settings → Quotation, as one document (schemas/crm.py QuotationSetup). */
export interface QuotationSetup {
  style: 'simple' | 'detailed'
  company_name: string | null
  phone: string | null
  email: string | null
  website: string | null
  gstin: string | null
  address: string | null
  number_format: string | null
  default_gst: string
  bank_enabled: boolean
  bank_name: string | null
  account_name: string | null
  account_number: string | null
  ifsc: string | null
  branch: string | null
  upi_enabled: boolean
  upi_id: string | null
  upi_name: string | null
  footer: string | null
  signatory: string | null
  /* Detailed / Proposal: the letterhead. */
  accent_color: string
  letterhead_align: 'left' | 'center'
  tagline: string | null
  cin: string | null
  pan: string | null
  show_gstin_in_header: boolean
  /* Detailed / Proposal: the covering letter and terms. {customer}, {company},
     {number} and {date} are filled in per quotation. */
  letter_subject: string | null
  letter_greeting: string | null
  letter_body: string | null
  letter_closing: string | null
  payment_terms: string | null
  delivery_terms: string | null
  warranty_terms: string | null
  /** Read-only: set by uploading on the same screen. */
  has_logo?: boolean
  has_stamp?: boolean
  images_version?: string | null
}

/** What the quotation editor reads from settings; open to every CRM user. */
export interface QuotationDefaults {
  home_state: string | null
  default_gst: string
  validity_days: number
  terms: string | null
}

export interface TrendPoint {
  day: string
  new_leads: number
  converted: number
}

export interface FunnelStage {
  status_id: string | null
  name: string
  colour: string
  behaviour: string
  count: number
  percent: number
}

export interface SourceStat {
  name: string
  count: number
  converted: number
  conversion_rate: number
}

export interface OwnerStat {
  owner_id: string | null
  name: string
  total: number
  converted: number
  pending_follow_ups: number
  conversion_rate: number
}

export interface LeadDashboard {
  total_leads: number
  total_leads_all_time: number
  new_leads: number
  todays_leads: number
  follow_ups_due_today: number
  pending_follow_ups: number
  overdue_follow_ups: number
  qualified_leads: number
  converted_leads: number
  lost_leads: number
  conversion_rate: number
  trend: TrendPoint[]
  funnel: FunnelStage[]
  sources: SourceStat[]
  owners: OwnerStat[]
}

/* ---------------------------------------------------------------- helpers --- */

/** The server's typed refusal, rendered as the sentence it wrote.
 *
 * `api.ts` flattens a non-string `detail` to JSON text, so a 409 arrives as
 * `{"reason":"master_in_use","message":"42 leads still use this entry…"}`. The
 * message is right there; showing the JSON instead is the bug this prevents. */
export function crmError(err: unknown, fallback: string): string {
  const raw = err instanceof ApiError || err instanceof Error ? err.message : String(err ?? '')
  if (!raw) return fallback
  if (raw.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { message?: unknown; reason?: unknown }
      if (typeof parsed.message === 'string') return parsed.message
      if (typeof parsed.reason === 'string') return parsed.reason
    } catch {
      /* Not JSON after all. */
    }
  }
  return raw
}

/** A decimal string from the API, as rupees. Never used for arithmetic. */
export function rupees(value: string | number | null | undefined): string {
  const amount = Number(value ?? 0)
  if (!Number.isFinite(amount)) return '₹0.00'
  return `₹${amount.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/** The same, without the paise — for tiles, where two decimals are noise. */
export function rupeesShort(value: string | number | null | undefined): string {
  const amount = Number(value ?? 0)
  if (!Number.isFinite(amount)) return '₹0'
  return `₹${Math.round(amount).toLocaleString('en-IN')}`
}

/** `<input type="datetime-local">` ⇄ an ISO instant.
 *
 * The input speaks browser-local time with no zone; the API speaks UTC. These
 * two are the only place that conversion happens, so a follow-up booked for
 * 3pm is 3pm where the person booking it is sitting. */
export function localToISO(value: string): string | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`
  const parsed = new Date(withZone)
  if (Number.isNaN(parsed.getTime())) return ''
  const offset = parsed.getTimezoneOffset() * 60_000
  return new Date(parsed.getTime() - offset).toISOString().slice(0, 16)
}

export function todayISO(): string {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10)
}

export function daysFromTodayISO(days: number): string {
  const now = new Date()
  now.setDate(now.getDate() + days)
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10)
}

/** "in 12d" / "6d ago" / "today" — the renewal and due-date column. */
export function inDays(days: number | null | undefined): string {
  if (days === null || days === undefined) return '—'
  if (days === 0) return 'today'
  if (days > 0) return `in ${days}d`
  return `${Math.abs(days)}d ago`
}

/** Query string from a filter object, skipping the empties. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

/* ------------------------------------------------------------------- calls --- */

export const crm = {
  masters: <T = Master>(kind: string, parentId?: string) =>
    api.get<T[]>(`/crm/masters/${kind}${qs({ parent_id: parentId })}`),
  createMaster: <T = Master>(kind: string, body: unknown) =>
    api.post<T>(`/crm/masters/${kind}`, body),
  updateMaster: <T = Master>(kind: string, id: string, body: unknown) =>
    api.put<T>(`/crm/masters/${kind}/${id}`, body),
  deleteMaster: (kind: string, id: string) => api.del(`/crm/masters/${kind}/${id}`),

  settings: () => api.get<CrmSettings>('/crm/settings'),
  quotationDefaults: () => api.get<QuotationDefaults>('/crm/quotation-defaults'),
  saveSettings: (body: Partial<CrmSettings>) => api.put<CrmSettings>('/crm/settings', body),
  rotateIntake: () => api.post<CrmSettings>('/crm/settings/intake-token'),

  dashboard: (params: Record<string, string | undefined>) =>
    api.get<LeadDashboard>(`/crm/dashboard${qs(params)}`),

  leads: (params: Record<string, string | number | undefined>) =>
    api.get<LeadPage>(`/crm/leads${qs(params)}`),
  lead: (id: string) => api.get<LeadDetail>(`/crm/leads/${id}`),
  createLead: (body: unknown) => api.post<Lead>('/crm/leads', body),
  patchLead: (id: string, body: unknown) => api.patch<Lead>(`/crm/leads/${id}`, body),
  moveLead: (id: string, body: unknown) => api.post<Lead>(`/crm/leads/${id}/status`, body),
  deleteLead: (id: string) => api.del(`/crm/leads/${id}`),
  deleteCustomer: (id: string) => api.del(`/crm/customers/${id}`),
  addActivity: (id: string, body: unknown) =>
    api.post<Activity>(`/crm/leads/${id}/activities`, body),
  convertLead: (id: string, body: unknown) =>
    api.post<Customer>(`/crm/leads/${id}/convert`, body),
  assignLeads: (body: unknown) => api.post<{ moved: number }>('/crm/leads/assign', body),
  importLeads: (body: unknown) =>
    api.post<{ created: number; skipped: number; errors: string[] }>('/crm/leads/import', body),

  followUps: (params: Record<string, string | undefined>) =>
    api.get<FollowUp[]>(`/crm/follow-ups${qs(params)}`),
  createFollowUp: (body: unknown) => api.post<FollowUp>('/crm/follow-ups', body),
  completeFollowUp: (id: string, body: unknown) =>
    api.post<FollowUp>(`/crm/follow-ups/${id}/complete`, body),
  cancelFollowUp: (id: string) => api.del(`/crm/follow-ups/${id}`),
  deleteFollowUp: (id: string) => api.del(`/crm/follow-ups/${id}?permanent=true`),
  importFollowUps: (body: unknown) =>
    api.post<{ created: number; errors: string[] }>('/crm/follow-ups/import', body),

  customers: (params: Record<string, string | undefined>) =>
    api.get<Customer[]>(`/crm/customers${qs(params)}`),
  customer: (id: string) => api.get<CustomerDetail>(`/crm/customers/${id}`),
  createCustomer: (body: unknown) => api.post<Customer>('/crm/customers', body),
  patchCustomer: (id: string, body: unknown) => api.patch<Customer>(`/crm/customers/${id}`, body),
  addPlan: (customerId: string, body: unknown) =>
    api.post<CustomerPlan>(`/crm/customers/${customerId}/plans`, body),
  updatePlan: (planId: string, body: unknown) => api.put<CustomerPlan>(`/crm/plans/${planId}`, body),
  deletePlan: (planId: string) => api.del(`/crm/plans/${planId}`),

  interactions: (params: Record<string, string | number | undefined>) =>
    api.get<Interaction[]>(`/crm/interactions${qs(params)}`),
  supportSummary: () =>
    api.get<{ logged_today: number; open: number; closed: number }>('/crm/interactions/summary'),
  logInteraction: (body: unknown) => api.post<Interaction>('/crm/interactions', body),
  closeInteraction: (id: string) => api.post<Interaction>(`/crm/interactions/${id}/close`),

  visits: (params: Record<string, string | undefined>) =>
    api.get<Visit[]>(`/crm/visits${qs(params)}`),
  visitSummary: () =>
    api.get<{
      today: number; pending: number; in_progress: number
      completed: number; overdue: number; cancelled: number
    }>('/crm/visits/summary'),
  createVisit: (body: unknown) => api.post<Visit>('/crm/visits', body),
  patchVisit: (id: string, body: unknown) => api.patch<Visit>(`/crm/visits/${id}`, body),
  issueOtp: (id: string) => api.post<{ otp: string }>(`/crm/visits/${id}/otp`),
  startVisit: (id: string, body: unknown) => api.post<Visit>(`/crm/visits/${id}/start`, body),
  closeVisit: (id: string, body: unknown) => api.post<Visit>(`/crm/visits/${id}/close`, body),
  cancelVisit: (id: string) => api.post<Visit>(`/crm/visits/${id}/cancel`),
  deleteVisit: (id: string) => api.del(`/crm/visits/${id}`),

  quotations: (params: Record<string, string | undefined>) =>
    api.get<QuotationRow[]>(`/crm/quotations${qs(params)}`),
  quotationSummary: () =>
    api.get<{ count: number; open_value: string; accepted_value: string; expired: number }>(
      '/crm/quotations/summary',
    ),
  quotation: (id: string) => api.get<Quotation>(`/crm/quotations/${id}`),
  createQuotation: (body: unknown) => api.post<Quotation>('/crm/quotations', body),
  updateQuotation: (id: string, body: unknown) => api.put<Quotation>(`/crm/quotations/${id}`, body),
  setQuotationStatus: (id: string, body: unknown) =>
    api.post<Quotation>(`/crm/quotations/${id}/status`, body),
  duplicateQuotation: (id: string) => api.post<Quotation>(`/crm/quotations/${id}/duplicate`),
  deleteQuotation: (id: string) => api.del(`/crm/quotations/${id}`),

  reminders: () => api.get<Reminder[]>('/crm/reminders'),
  reminderHistory: () => api.get<ReminderRun[]>('/crm/reminders/history'),
  createReminder: (body: unknown) => api.post<Reminder>('/crm/reminders', body),
  updateReminder: (id: string, body: unknown) => api.put<Reminder>(`/crm/reminders/${id}`, body),
  toggleReminder: (id: string, active: boolean) =>
    api.post<Reminder>(`/crm/reminders/${id}/active?active=${active}`),
  deleteReminder: (id: string) => api.del(`/crm/reminders/${id}`),
}

/** WhatsApp deep link for a number, or null when there is nothing to dial. */
export function whatsappLink(mobile: string | null | undefined, text?: string): string | null {
  const digits = (mobile ?? '').replace(/\D/g, '')
  if (digits.length < 8) return null
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`
}
