import { getSlug } from './tenant'

const TOKEN_KEY = 'hrdesktimesol.token'

/**
 * Where the API lives.
 *
 * Empty by default, which keeps every call same-origin — the shape the nginx
 * image and the dev proxy both rely on, and the one that keeps the bearer token
 * off any other host.
 *
 * Set `VITE_API_BASE` when the console and the API are served from different
 * origins, which is every static-hosting deployment: Render Static Sites,
 * Vercel, and a native mobile shell, none of which have an API to be relative
 * to. Prefer a same-origin rewrite where the host offers one — a rewrite keeps
 * the browser's own origin and sidesteps CORS entirely.
 *
 * Trailing slash stripped so `https://api.example.com/` and the same without
 * do not produce `//api/v1`, which some proxies answer with a redirect the
 * fetch then repeats as a GET.
 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')

/** Every call names its tenant.
 *
 * Sent even when the subdomain already identifies the organisation: the dev
 * proxy rewrites the Host header, so the subdomain alone is not reliable in
 * development. The server prefers the Host and falls back to this, and the two
 * are checked against each other, so sending both is safe. */
function withTenant(headers: Headers): Headers {
  const slug = getSlug()
  if (slug) headers.set('X-Org-Slug', slug)
  return headers
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  /**
   * The server's machine-readable cause, when it sent one.
   *
   * Handlers refuse with `{reason, message}` in a lot of places — `deny_page`
   * and `deny_unless` always have, and every HRMS service does — so a page that
   * wants to branch on *why* it was refused (offer a different action for
   * `page_hidden` than for `insufficient_balance`) can read this instead of
   * matching on prose that will be reworded.
   */
  constructor(
    public status: number,
    message: string,
    public reason?: string,
    /**
     * The rest of the typed body.
     *
     * Several refusals carry the thing the caller actually needs: a 409
     * `clearance_incomplete` names the `blocking_tasks` that are holding an
     * exit open, which is the entire value of the refusal. Dropping it left
     * pages rebuilding that list from their own state and re-deriving the
     * server's rule to do it.
     */
    public detail?: Record<string, unknown>,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers = withTenant(new Headers(init.headers))
  if (token) headers.set('Authorization', `Bearer ${token}`)
  // FormData is excluded on purpose. The browser has to write Content-Type
  // itself for multipart, because only it knows the boundary token it generated
  // — stamping application/json here produces a body the server cannot parse,
  // and the failure looks like a server bug rather than a header one.
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(`${API_BASE}/api/v1${path}`, { ...init, headers })

  // Only a request that carried a session can have lost one. A 401 to a
  // tokenless call — sign-in with the wrong password — is an answer, not an
  // expiry, and reloading here wiped the "wrong password" message before it
  // could be read.
  if (response.status === 401 && token) {
    setToken(null)
    // Full reload rather than a router push: every cached query in memory is
    // now for a session that no longer exists.
    window.location.href = '/login'
    throw new ApiError(401, 'Session expired')
  }
  if (!response.ok) {
    const { message, reason, detail } = await readError(response)
    throw new ApiError(response.status, message, reason, detail)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/**
 * Turn an error response into something a person can read.
 *
 * The object case is the one that matters. Handlers refuse with
 * `detail: {reason, message}` — `deny_page`, `deny_unless`, and every HRMS
 * service — and the previous fallback here was `JSON.stringify(detail)`, so an
 * employee applying for more leave than they have was shown
 * `{"reason":"insufficient_balance","message":"Casual Leave: 3 days requested…"}`
 * verbatim. The message was right there; it was the serialiser that was wrong.
 *
 * Ordering is deliberate: a string detail wins, then FastAPI's validation-error
 * list, then our typed object, then the raw body as a last resort. Only the
 * last of those should ever reach a user, and if it does it is a bug worth
 * seeing rather than hiding behind "Something went wrong".
 */
async function readError(
  response: Response,
): Promise<{ message: string; reason?: string; detail?: Record<string, unknown> }> {
  try {
    const body = await response.json()
    const detail = body?.detail
    if (typeof detail === 'string') return { message: detail }
    if (Array.isArray(detail)) {
      return { message: detail.map((d) => d.msg ?? String(d)).join('; ') }
    }
    if (detail && typeof detail === 'object' && typeof detail.message === 'string') {
      return { message: detail.message, reason: detail.reason, detail }
    }
    return { message: JSON.stringify(detail ?? body).slice(0, 300) }
  } catch {
    return { message: `Request failed (HTTP ${response.status})` }
  }
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T,>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T,>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  /* Generic, because a DELETE is allowed to answer with something. Chat's
     message removal is a soft delete and returns the tombstoned row, so the
     caller can swap it into the thread rather than refetching the page. The
     default stays `void` for the callers that ignore the body. */
  del: <T = void,>(path: string) => request<T>(path, { method: 'DELETE' }),
  /**
   * Multipart upload.
   *
   * Deliberately does NOT set Content-Type: the browser must write it itself so
   * it can append the multipart boundary. Setting it by hand produces a request
   * the server cannot parse, which is the trap that makes pages hand-roll
   * `fetch` here — and a hand-rolled call is one that forgets the tenant header
   * or the 401 handling.
   */
  upload: <T,>(path: string, form: FormData) =>
    request<T>(path, { method: 'POST', body: form }),
}

/** Fetches an authenticated image and returns an object URL. */
export async function fetchImage(path: string): Promise<string> {
  const token = getToken()
  const headers = withTenant(new Headers())
  if (token) headers.set('Authorization', `Bearer ${token}`)
  // The server hands back a root-relative URL ("/api/v1/screenshots/x/thumb"),
  // which needs the base like any other call once the console is on a different
  // origin. Only root-relative ones: the s3 backend answers with a redirect to
  // an absolute presigned URL, and prefixing that would corrupt it.
  const target = path.startsWith('/') ? `${API_BASE}${path}` : path
  const response = await fetch(target, { headers })
  if (!response.ok) throw new ApiError(response.status, 'Image unavailable')
  return URL.createObjectURL(await response.blob())
}

/** Triggers a browser download of an authenticated endpoint. */
export async function download(path: string, filename: string): Promise<void> {
  const token = getToken()
  const headers = withTenant(new Headers())
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`${API_BASE}/api/v1${path}`, { headers })
  if (!response.ok) {
    const { message, reason, detail } = await readError(response)
    throw new ApiError(response.status, message, reason, detail)
  }
  const url = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/** Opens an authenticated HTML endpoint in a new tab.
 *
 * A plain <a href> cannot be used: the route requires the Authorization and
 * tenant headers, so the anchor arrives unauthenticated and 401s. Fetching and
 * opening a blob URL is the only way to get a *viewable* page (rather than a
 * download) out of an authenticated endpoint.
 *
 * The blob URL is not revoked immediately — the new tab is still reading from
 * it. It is released on a timer instead; leaking one object URL per print is
 * cheaper than a tab that renders blank because the source was revoked
 * underneath it.
 */
export async function openPrintable(path: string): Promise<void> {
  const token = getToken()
  const headers = withTenant(new Headers())
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`${API_BASE}/api/v1${path}`, { headers })
  if (!response.ok) {
    const { message, reason, detail } = await readError(response)
    throw new ApiError(response.status, message, reason, detail)
  }
  const url = URL.createObjectURL(await response.blob())
  const opened = window.open(url, '_blank')
  if (!opened) {
    // Popup blocked. Fall through to a same-tab navigation rather than failing
    // silently, which reads as a dead button.
    window.location.href = url
    return
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Triggers a download from an endpoint that must be POSTed.
 *
 * The bank file is a POST although it reads nothing: it decrypts every account
 * on the run and writes an audit row, and a GET would be prefetched by the
 * browser, retried by a proxy, and logged. `download` above cannot express
 * that, so this exists rather than making the endpoint a GET to suit the
 * client.
 */
export async function downloadPost(path: string, filename: string): Promise<void> {
  const token = getToken()
  const headers = withTenant(new Headers())
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`${API_BASE}/api/v1${path}`, { method: 'POST', headers })
  if (!response.ok) {
    const { message, reason, detail } = await readError(response)
    throw new ApiError(response.status, message, reason, detail)
  }
  const url = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
