/**
 * Public signup API — no auth token, no tenant header.
 *
 * Kept separate from `api.ts` on purpose: that client attaches the tenant slug
 * to every call, and during signup the tenant does not exist yet.
 */

export interface PlanOption {
  id: string
  name: string
  description: string | null
  base_price_annual: number
  per_employee_month: number
  min_employees: number
  max_employees: number
  storage_gb: number
  screenshot_interval_min_s: number
  screenshot_retention_days: number
  features: string[]
}

export interface Quote {
  plan_id: string
  plan_name: string
  billing_cycle: string
  employees: number
  base_amount: number
  seat_amount: number
  subtotal: number
  tax_amount: number
  tax_rate_pct: number
  total: number
  currency: string
  total_display: string
  per_employee_month: number
  base_price_annual: number
}

export interface SlugCheck {
  slug: string
  available: boolean
  reason?: string | null
  suggestion?: string | null
}

export interface SignupOrder {
  organization_id: string
  slug: string
  subscription_id: string
  order_id: string
  amount: number
  currency: string
  razorpay_key_id: string
  simulated: boolean
  quote: Quote
  prefill: { name: string; email: string; contact: string }
}

export interface SignupComplete {
  organization_id: string
  slug: string
  login_url: string
  admin_email: string
  plan_name: string
  seats: number
  period_end: string | null
  status: string
}

export class SignupError extends Error {
  constructor(message: string, public reason?: string) {
    super(message)
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/signup${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
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
      /* keep the status-code message */
    }
    throw new SignupError(message, reason)
  }
  return (await response.json()) as T
}

export const signupApi = {
  plans: () => call<PlanOption[]>('/plans'),
  quote: (plan_id: string, employees: number, billing_cycle: string) =>
    call<Quote>('/quote', { method: 'POST', body: JSON.stringify({ plan_id, employees, billing_cycle }) }),
  checkSlug: (slug: string) => call<SlugCheck>(`/check-slug?slug=${encodeURIComponent(slug)}`),
  start: (body: unknown) => call<SignupOrder>('/start', { method: 'POST', body: JSON.stringify(body) }),
  trial: (body: unknown) => call<SignupComplete>('/trial', { method: 'POST', body: JSON.stringify(body) }),
  confirm: (body: unknown) => call<SignupComplete>('/confirm', { method: 'POST', body: JSON.stringify(body) }),
  simulate: (orderId: string) =>
    call<{ razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }>(
      `/simulate-payment/${orderId}`,
      { method: 'POST' },
    ),
}

/** Slugify a company name for the subdomain field. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

let checkoutPromise: Promise<void> | null = null

/** Load Razorpay's checkout script once, on demand. */
export function loadRazorpay(): Promise<void> {
  if (checkoutPromise) return checkoutPromise
  checkoutPromise = new Promise((resolve, reject) => {
    if ((window as any).Razorpay) return resolve()
    const script = document.createElement('script')
    script.src = 'https://checkout.razorpay.com/v1/checkout.js'
    script.onload = () => resolve()
    script.onerror = () => {
      checkoutPromise = null
      reject(new SignupError('Could not load the payment gateway. Check your connection.'))
    }
    document.head.appendChild(script)
  })
  return checkoutPromise
}
