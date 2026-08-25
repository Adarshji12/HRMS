import type { Productivity } from './types'

/** "7h 18m" — the form used in prose and tiles. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const hours = Math.floor(s / 3600)
  const minutes = Math.round((s % 3600) / 60)
  if (hours === 0) return `${minutes}m`
  if (minutes === 0) return `${hours}h`
  return `${hours}h ${minutes}m`
}

/** "7.18" — decimal hours, for table columns that must align. */
export function hours(seconds: number): string {
  return (seconds / 3600).toFixed(2)
}

/**
 * The API stores every instant in UTC but serialises some of them without a
 * zone marker — SQLite drops the tzinfo, so `captured_at` arrives as
 * "2026-08-18T06:23:53", not "...Z". `new Date()` reads a marker-less string as
 * *browser-local*, which silently shifts every such time by the viewer's
 * offset. Normalise here: if there is no 'Z' and no ±hh:mm offset, it is UTC.
 */
export function asUTC(iso: string): string {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`
}

export function clockTime(iso: string | null, timeZone?: string): string {
  if (!iso) return '—'
  return new Date(asUTC(iso)).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  })
}

export function dateTime(iso: string | null, timeZone?: string): string {
  if (!iso) return '—'
  return new Date(asUTC(iso)).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  })
}

export function todayISO(): string {
  const now = new Date()
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

export function daysAgoISO(days: number): string {
  const now = new Date()
  now.setDate(now.getDate() - days)
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

export function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function weekday(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short' })
}

export const PRODUCTIVITY_LABEL: Record<Productivity, string> = {
  productive: 'Productive',
  unproductive: 'Unproductive',
  neutral: 'Neutral',
}

/** Diverging scale — see the note at the top of styles.css. */
export const PRODUCTIVITY_COLOR: Record<Productivity, string> = {
  productive: 'var(--prod)',
  unproductive: 'var(--unprod)',
  neutral: 'var(--neutral-mark)',
}

export function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  // asUTC, like clockTime and dateTime — this function was the one that did not.
  // A marker-less timestamp (which is what SQLite hands back) was being read as
  // local time, so east of UTC every "5 minutes ago" was computed from an
  // instant several hours in the future and rendered as "just now" forever.
  const deltaS = (Date.now() - new Date(asUTC(iso)).getTime()) / 1000
  // Clock skew between the server and the viewer's machine is normal and small.
  // Without this a future instant produces "-3m ago", which reads as a bug in
  // the data rather than a few seconds of drift.
  if (deltaS < 60) return 'just now'
  if (deltaS < 3600) return `${Math.floor(deltaS / 60)}m ago`
  if (deltaS < 86400) return `${Math.floor(deltaS / 3600)}h ago`
  return `${Math.floor(deltaS / 86400)}d ago`
}

/** Paise to rupees, exactly.
 *
 * Two decimal places always, because these are claim amounts somebody is owed
 * and "₹250" where the row says 250.50 is a support ticket. Distinct from
 * `rupees()` in platformApi, which rounds to whole rupees deliberately —
 * subscription prices are always whole and the decimals there are noise.
 *
 * The division is the only float in the pipeline and it happens at the very
 * edge, on a value that is about to become a string. Never feed the result back
 * into arithmetic.
 */
export function money(paise: number, currency = 'INR'): string {
  const symbol = currency === 'INR' ? '₹' : `${currency} `
  return `${symbol}${(paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/** Rupees typed by a human to integer paise, or null if it is not a number.
 *
 * `Math.round` rather than truncation: 250.555 entered in a form is meant as
 * 250.56, and truncating would quietly short-pay by a paisa every time.
 */
export function toPaise(input: string): number | null {
  const cleaned = input.replace(/[,\s₹]/g, '')
  if (!cleaned || !/^\d*\.?\d*$/.test(cleaned)) return null
  const value = Number(cleaned)
  if (!Number.isFinite(value)) return null
  return Math.round(value * 100)
}
