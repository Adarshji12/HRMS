/**
 * Super Admin API client.
 *
 * A separate token, in a separate storage key, from the company console. They
 * are different credentials for different systems, and sharing a key would mean
 * signing out of one silently signs out of the other — or worse, that a stale
 * company token gets sent to a platform endpoint.
 *
 * No tenant header: platform operators belong to no organisation.
 */

const TOKEN_KEY = 'hrdesktimesol.platform_token'

export function getPlatformToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setPlatformToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

export class PlatformError extends Error {
  constructor(message: string, public status: number, public reason?: string) {
    super(message)
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getPlatformToken()
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  const response = await fetch(`/api/v1/platform${path}`, { ...init, headers })

  if (response.status === 401) {
    setPlatformToken(null)
    window.location.href = '/platform/login'
    throw new PlatformError('Session expired', 401)
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    let reason: string | undefined
    try {
      const detail = (await response.json())?.detail
      if (typeof detail === 'string') message = detail
      else if (Array.isArray(detail)) message = detail.map((d) => d.msg ?? String(d)).join('; ')
      else if (detail?.message) {
        message = detail.message
        reason = detail.reason
      }
    } catch {
      /* keep the status message */
    }
    throw new PlatformError(message, response.status, reason)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}


export interface MailSettingsIn {
  smtp_host: string
  smtp_port: number
  smtp_user: string
  /** Omit to keep the stored password; "" clears it. Never returned by the API. */
  smtp_password?: string
  smtp_use_tls: boolean
  email_from: string
}

export interface MailState {
  configured: boolean
  smtp_host: string
  smtp_port: number
  smtp_user: string
  smtp_use_tls: boolean
  email_from: string
  /** Whether a password is stored. The value itself is never returned. */
  has_password: boolean
  last_test: { at: string | null; to: string | null; ok: boolean | null; error: string | null }
}


export interface PlatformHealth {
  generated_at: string
  mail: {
    own_connector: number
    using_platform: number
    none: number
    platform_configured: boolean
  }
  alerts: {
    sent_7d: number
    failed_7d: number
    logged_7d: number
    last_activity_at: string | null
  }
  agents: {
    devices_total: number
    devices_stale_24h: number
    versions: Array<{ version: string; devices: number }>
  }
  storage: { screenshot_bytes: number }
}

export interface AuditItem {
  at: string
  action: string
  organization: string
  actor: string
  target_type: string | null
  target_id: string | null
  detail: Record<string, unknown> | null
  ip: string | null
}

export interface PlanRow {
  id: string
  name: string
  description: string | null
  base_price_annual: number
  per_employee_month: number
  min_employees: number
  max_employees: number
  max_screenshot_retention_days: number
  max_activity_retention_days: number
  min_screenshot_interval_s: number
  storage_gb: number
  features: string[]
  is_active: boolean
  is_public: boolean
  /** Ships with the product: editable, never deletable. */
  is_builtin: boolean
  sort_order: number
  /** How many subscriptions name this plan. Non-zero means delete is refused. */
  subscriptions: number
  /** Only present on the response to an edit — how many companies were clamped. */
  organizations_clamped?: number
}

/** A new plan. `id` is the slug subscriptions store, so it is set once. */
export interface PlanCreate extends PlanWrite {
  id: string
}

/** Every editable field of a plan. Money is in paise, as the API expects. */
export interface PlanWrite {
  name: string
  description?: string | null
  base_price_annual: number
  per_employee_month: number
  min_employees: number
  max_employees: number
  max_screenshot_retention_days: number
  max_activity_retention_days: number
  min_screenshot_interval_s: number
  storage_gb: number
  features: string[]
  is_active: boolean
  is_public: boolean
  sort_order: number
}

export interface CompanyUpdate {
  name?: string
  slug?: string
  timezone?: string
  legal_name?: string | null
  contact_email?: string | null
  contact_phone?: string | null
  address_line1?: string | null
  address_line2?: string | null
  city?: string | null
  state?: string | null
  postal_code?: string | null
  country?: string
  gstin?: string | null
  industry?: string | null
}


export interface CompanyCreate {
  name: string
  slug: string
  timezone?: string
  owner_name: string
  owner_email: string
  owner_password?: string
  plan_id?: string
  seats?: number
  valid_days?: number
  notes?: string
  legal_name?: string
  contact_phone?: string
  gstin?: string
  city?: string
  country?: string
  send_welcome_email?: boolean
}

export interface CompanyCreated {
  organization_id: string
  name: string
  slug: string
  login_url: string
  owner_email: string
  /** Readable exactly once — the database keeps only a hash. */
  owner_password: string
  generated_password: boolean
  plan: string
  seats: number
  status: string
  period_end: string | null
  welcome_email_sent: boolean
}

export const platformApi = {
  login: (email: string, password: string) =>
    call<{ access_token: string; admin: PlatformAdmin }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: () => call<PlatformAdmin>('/auth/me'),
  changePassword: (current_password: string, new_password: string) =>
    call<PlatformAdmin>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password, new_password }),
    }),
  stats: () => call<PlatformStats>('/stats'),
  health: () => call<PlatformHealth>('/health'),
  createCompany: (body: CompanyCreate) =>
    call<CompanyCreated>('/companies', { method: 'POST', body: JSON.stringify(body) }),
  plans: () => call<PlanRow[]>('/plans'),
  audit: (params: { limit?: number; action?: string } = {}) => {
    const q = new URLSearchParams()
    if (params.limit) q.set('limit', String(params.limit))
    if (params.action) q.set('action', params.action)
    return call<{ items: AuditItem[] }>(`/audit?${q}`).then((r) => r.items)
  },
  mail: () => call<MailState>('/mail'),
  saveMail: (body: MailSettingsIn) =>
    call<MailState>('/mail', { method: 'PUT', body: JSON.stringify(body) }),
  testMail: (to: string) =>
    call<MailState & { ok: boolean }>('/mail/test', {
      method: 'POST',
      body: JSON.stringify({ to }),
    }),
  companies: (params: Record<string, string>) => {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v))
    return call<CompanyRow[]>(`/companies?${query}`)
  },
  company: (id: string) => call<CompanyDetail>(`/companies/${id}`),
  employees: (id: string) => call<PlatformEmployee[]>(`/companies/${id}/employees`),
  suspend: (id: string, reason: string) =>
    call<CompanyRow>(`/companies/${id}/suspend`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  activate: (id: string) => call<CompanyRow>(`/companies/${id}/activate`, { method: 'POST' }),
  updateCompany: (id: string, body: CompanyUpdate) =>
    call<CompanyRow>(`/companies/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  /** Permanent. `confirm_slug` must match the workspace slug exactly. */
  deleteCompany: (id: string, confirm_slug: string, reason?: string) =>
    call<{ deleted: string; name: string; slug: string; screenshot_files_removed: number }>(
      `/companies/${id}`,
      { method: 'DELETE', body: JSON.stringify({ confirm_slug, reason }) },
    ),
  overrideSubscription: (id: string, body: SubscriptionOverride) =>
    call<SubscriptionRow>(`/companies/${id}/subscription`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  createPlan: (body: PlanCreate) =>
    call<PlanRow>('/plans', { method: 'POST', body: JSON.stringify(body) }),
  updatePlan: (id: string, body: Partial<PlanWrite>) =>
    call<PlanRow>(`/plans/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deletePlan: (id: string) => call<{ deleted: string }>(`/plans/${id}`, { method: 'DELETE' }),
  /** The module registry — what the grants panel and plan editor render. */
  moduleRegistry: () => call<ModuleDef[]>('/modules'),
  companyModules: (id: string) => call<CompanyModules>(`/companies/${id}/modules`),
  /**
   * Replaces the override map wholesale; it does not merge. Modules left out
   * of `grants` return to whatever the plan says, which is how the panel
   * expresses "inherit" — there is no separate clear call to get out of step
   * with this one.
   */
  saveCompanyModules: (id: string, grants: ModuleGrant[]) =>
    call<CompanyModules>(`/companies/${id}/modules`, {
      method: 'PUT',
      body: JSON.stringify({ grants }),
    }),
}

/* ----------------------------------------------------------------- types -- */

export interface ModuleDef {
  key: string
  label: string
  description: string
  group: string
  status: 'live' | 'planned'
  grantable: boolean
}

/** A registry entry plus how it resolved for one company. */
export interface CompanyModule extends ModuleDef {
  enabled: boolean
  /** Whether the plan alone would allow it — what `enabled` falls back to. */
  in_plan: boolean
  /** null = inherit from the plan; true/false = an operator forced it. */
  override: boolean | null
  source: 'plan' | 'grant'
}

export interface CompanyModules {
  plan_id: string
  plan_name: string
  /** An empty module list on the plan means every module, not none. */
  plan_unrestricted: boolean
  modules: CompanyModule[]
}

export interface ModuleGrant {
  key: string
  /** Omit or null to inherit from the plan. */
  enabled?: boolean | null
}

export interface PlatformAdmin {
  id: string
  email: string
  full_name: string
  is_active: boolean
  last_login_at: string | null
  must_change_password: boolean
}

export interface PlatformStats {
  companies_total: number
  companies_active: number
  companies_suspended: number
  companies_trialing: number
  employees_total: number
  employees_online: number
  revenue_active_paise: number
  subscriptions_expiring_30d: number
}

export interface CompanyRow {
  id: string
  name: string
  slug: string
  status: string
  timezone: string
  contact_email: string | null
  contact_phone: string | null
  created_at: string
  admin_name: string | null
  admin_email: string | null
  plan_id: string
  plan_name: string
  subscription_status: string
  billing_cycle: string | null
  period_start: string | null
  period_end: string | null
  days_remaining: number | null
  payment_status: string
  seat_limit: number
  seats_used: number
  employees_online: number
}

export interface SubscriptionRow {
  id: string
  plan_id: string
  billing_cycle: string
  seats: number
  status: string
  base_amount: number
  seat_amount: number
  tax_amount: number
  total_amount: number
  currency: string
  period_start: string | null
  period_end: string | null
  activated_at: string | null
  canceled_at: string | null
  notes: string | null
  created_at: string
}

export interface PaymentRow {
  id: string
  provider: string
  order_id: string
  payment_id: string | null
  amount: number
  currency: string
  status: string
  method: string | null
  error_description: string | null
  paid_at: string | null
  created_at: string
}

export interface CompanyDetail extends CompanyRow {
  legal_name: string | null
  gstin: string | null
  city: string | null
  state: string | null
  country: string
  suspended_reason: string | null
  usage: {
    seats_used: number
    seat_limit: number
    seats_available: number
    screenshots: number
    storage_bytes: number
    storage_gb_limit: number
    status: string
    plan_id: string
    plan_name: string
    days_remaining: number | null
  }
  subscriptions: SubscriptionRow[]
  payments: PaymentRow[]
  recent_activity: Array<{ action: string; at: string | null; detail: unknown }>
}

export interface PlatformEmployee {
  id: string
  full_name: string
  email: string
  role: string
  team: string | null
  is_active: boolean
  last_seen_at: string | null
  is_online: boolean
}

export interface SubscriptionOverride {
  plan_id?: string
  seats?: number
  status?: string
  extend_days?: number
  notes?: string
}

export function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(0)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}
