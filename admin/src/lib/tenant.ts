/**
 * Which organisation this browser tab is talking to.
 *
 * In production the tenant comes from the subdomain — `acme.mydesktime.io` is
 * Acme, and there is nothing to choose. On plain `localhost` (and for anyone
 * hitting the app without a subdomain) there is no such signal, so the sign-in
 * page asks once and the answer is remembered.
 *
 * This mirrors `server/app/api/tenancy.py`. Keep the reserved list and the
 * base-domain logic in step with it.
 */

const STORAGE_KEY = 'hrdesktimesol.org'

export const BASE_DOMAIN = (import.meta.env.VITE_BASE_DOMAIN ?? 'localhost').toLowerCase()

const RESERVED = new Set([
  'www', 'app', 'api', 'admin', 'static', 'assets', 'cdn', 'mail', 'smtp', 'ftp',
  'ns1', 'ns2', 'status', 'docs', 'help', 'support', 'blog', 'dashboard',
  'billing', 'account', 'login', 'signup', 'auth', 'sentinel', 'hrdesktimesol', 'root', 'system',
  'internal', 'test', 'staging', 'dev',
])

/** The slug in the current hostname, or null when there isn't one. */
export function slugFromHostname(hostname: string = window.location.hostname): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host || host === BASE_DOMAIN) return null
  if (!host.endsWith(`.${BASE_DOMAIN}`)) return null

  const label = host.slice(0, -(BASE_DOMAIN.length + 1))
  // Only the left-most label is the tenant; anything deeper is not a tenant host.
  if (!label || label.includes('.') || RESERVED.has(label)) return null
  return label
}

export type SlugSource = 'host' | 'stored' | null

export function slugSource(): SlugSource {
  if (slugFromHostname()) return 'host'
  if (localStorage.getItem(STORAGE_KEY)) return 'stored'
  return null
}

/** The slug to send with API calls. The hostname always wins over storage. */
export function getSlug(): string | null {
  return slugFromHostname() ?? localStorage.getItem(STORAGE_KEY)
}

export function setSlug(slug: string | null): void {
  if (slug) localStorage.setItem(STORAGE_KEY, slug.trim().toLowerCase())
  else localStorage.removeItem(STORAGE_KEY)
}

/** Where this tenant lives once real subdomains are in play. */
export function tenantUrl(slug: string): string {
  const port = window.location.port ? `:${window.location.port}` : ''
  return `${window.location.protocol}//${slug}.${BASE_DOMAIN}${port}`
}
