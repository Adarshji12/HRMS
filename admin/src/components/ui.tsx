import type { ReactNode } from 'react'

export function StatTile({
  label,
  value,
  meta,
  accent,
  icon,
}: {
  label: string
  value: string
  meta?: ReactNode
  accent?: string
  icon?: ReactNode
}) {
  // The accent tints the rail and the numeral together. Passing it once keeps
  // those two from drifting apart, which is what made the old tiles read as
  // "some numbers happen to be blue".
  return (
    <div className="card tile" style={accent ? ({ '--tile-accent': accent } as never) : undefined}>
      <div className="tile-label">
        {icon}
        {label}
      </div>
      <div className="tile-value" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      {meta && <div className="tile-meta">{meta}</div>}
    </div>
  )
}

/* Proportion bar. `accent` is optional and defaults to brand; pass a data token
   only when the figure is a data measure rather than a quota. */
export function Meter({ value, max, accent }: { value: number; max: number; accent?: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  return (
    <div
      className="meter"
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="meter-fill"
        style={{ width: `${pct}%`, ...(accent ? { background: accent } : null) }}
      />
    </div>
  )
}

/* Fixed logo-family shades keep person badges consistent and readable. */
const AVATAR_COLORS = [
  '#004070', '#003458', '#005c75', '#007392',
  '#087999', '#175d7a', '#28667f', '#355b70',
]

export function avatarColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function Avatar({ name, small }: { name: string; small?: boolean }) {
  return (
    <span
      className={`avatar${small ? ' avatar-sm' : ''}`}
      style={{ ['--avatar-bg' as never]: avatarColor(name) }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  )
}

/* Avatar + name + a secondary line, for the leading cell of a person table. */
export function Identity({ name, meta, small }: { name: string; meta?: ReactNode; small?: boolean }) {
  return (
    <div className="identity">
      <Avatar name={name} small={small} />
      <div className="identity-body">
        <div className="identity-name">{name}</div>
        {meta && <div className="identity-meta">{meta}</div>}
      </div>
    </div>
  )
}

export function OnlineBadge({ online }: { online: boolean }) {
  return (
    <span className={`badge ${online ? 'status-online' : 'status-offline'}`}>
      <span
        className="badge-dot"
        style={{ background: online ? 'var(--status-good)' : 'var(--text-muted)' }}
      />
      {online ? 'Online' : 'Offline'}
    </span>
  )
}

export function ProductivityBadge({ value }: { value: 'productive' | 'unproductive' | 'neutral' }) {
  const colors = {
    productive: 'var(--prod)',
    unproductive: 'var(--unprod)',
    neutral: 'var(--neutral-mark)',
  }
  const labels = { productive: 'Productive', unproductive: 'Unproductive', neutral: 'Neutral' }
  return (
    <span className="badge">
      <span className="badge-dot" style={{ background: colors[value] }} />
      {labels[value]}
    </span>
  )
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="error">{children}</div>
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>
}

/* A panel with nothing in it. `body` should say what would make something
   appear here, not just restate that it is empty. */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode
  title: string
  body?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {body && <div className="empty-body">{body}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {label}
    </div>
  )
}
