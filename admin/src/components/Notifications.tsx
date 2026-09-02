import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useQuery } from '../lib/useQuery'
import { IconAlert, IconBell, IconCheck, IconInfo } from './Icons'

/**
 * Attention feed.
 *
 * There is no notifications table on the server and this does not invent one —
 * it derives what needs a decision from state the console already exposes, and
 * re-derives it on a poll. That means an item disappears the moment the thing
 * it describes is dealt with, which a stored-notification table only manages
 * with a matching write on every mutation path.
 *
 * The trade is that these are conditions, not events: it cannot tell you what
 * happened while you were away, only what is true now. For approvals, seats and
 * billing — the three things here — that is the more useful of the two.
 */

interface TeamSheet {
  pending_approvals: number
}

interface Subscription {
  status: string
  days_remaining: number | null
  usage: {
    seats_used: number
    seat_limit: number
    seats_available: number
    storage_bytes: number
    storage_gb_limit: number
  }
}

type Tone = 'info' | 'warn' | 'critical'

interface Note {
  /** Carries the value, so a changed count reads as new rather than as seen. */
  id: string
  tone: Tone
  title: string
  body: string
  to: string
}

const READ_KEY = 'hrdesktimesol.notes-read'

function readIds(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(READ_KEY) ?? '[]')
    return new Set(Array.isArray(raw) ? (raw as string[]) : [])
  } catch {
    return new Set()
  }
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function build(team: TeamSheet | undefined, sub: Subscription | undefined): Note[] {
  const notes: Note[] = []

  if (team && team.pending_approvals > 0) {
    notes.push({
      id: `timesheets:pending:${team.pending_approvals}`,
      tone: 'warn',
      title: `${plural(team.pending_approvals, 'timesheet', 'timesheets')} awaiting approval`,
      body: 'Submitted for this period and not yet reviewed.',
      to: '/timesheets',
    })
  }

  if (sub) {
    const { usage } = sub
    if (sub.status === 'past_due' || sub.status === 'expired' || sub.status === 'suspended') {
      notes.push({
        id: `billing:${sub.status}`,
        tone: 'critical',
        title: sub.status === 'past_due' ? 'Payment overdue' : `Subscription ${sub.status}`,
        body: 'Tracking continues, but the console will lock without a renewal.',
        to: '/billing',
      })
    } else if (sub.status === 'trialing' && sub.days_remaining !== null && sub.days_remaining <= 14) {
      notes.push({
        id: `billing:trial:${sub.days_remaining}`,
        tone: sub.days_remaining <= 3 ? 'critical' : 'warn',
        title:
          sub.days_remaining <= 0
            ? 'Trial has ended'
            : `Trial ends in ${plural(sub.days_remaining, 'day', 'days')}`,
        body: 'Choose a plan to keep tracking after the trial.',
        to: '/billing',
      })
    }

    if (usage.seat_limit > 0 && usage.seats_available <= 0) {
      notes.push({
        id: `seats:full:${usage.seats_used}`,
        tone: 'warn',
        title: 'Seat limit reached',
        body: `${usage.seats_used} of ${usage.seat_limit} seats in use — no room to add an employee.`,
        to: '/billing',
      })
    }

    const limitBytes = usage.storage_gb_limit * 1024 ** 3
    if (limitBytes > 0 && usage.storage_bytes / limitBytes >= 0.9) {
      const pct = Math.round((usage.storage_bytes / limitBytes) * 100)
      notes.push({
        id: `storage:${pct}`,
        tone: pct >= 100 ? 'critical' : 'warn',
        title: `Screenshot storage ${pct}% full`,
        body: 'Shorten the retention window or move to a larger plan.',
        to: '/settings',
      })
    }
  }

  return notes
}

const TONE_ICON: Record<Tone, (p: { size?: number }) => JSX.Element> = {
  info: IconInfo,
  warn: IconAlert,
  critical: IconAlert,
}

export default function Notifications({ isAdmin }: { isAdmin: boolean }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [read, setRead] = useState<Set<string>>(readIds)
  const wrapRef = useRef<HTMLDivElement>(null)

  /* Two small endpoints on a slow poll, each gated to a role that can actually
     reach it. The team sheet needs a reviewer: polling it for an employee was a
     403 in their console every two minutes — swallowed, so it changed nothing on
     screen, but a recurring error in the log of a monitoring product is exactly
     the noise that hides a real one. */
  const { user } = useAuth()
  const canReview = !!user && user.role !== 'employee'
  const team = useQuery<TeamSheet>(
    'notes:timesheets',
    () => api.get<TeamSheet>(`/timesheets/team?day=${todayISO()}&period=weekly`),
    { enabled: canReview, pollMs: 120_000 },
  )
  const subscription = useQuery<Subscription>(
    'notes:subscription',
    () => api.get<Subscription>('/admin/subscription'),
    { enabled: isAdmin, pollMs: 300_000 },
  )

  const notes = useMemo(
    () => build(team.data, subscription.data),
    [team.data, subscription.data],
  )
  const unread = notes.filter((note) => !read.has(note.id))

  useEffect(() => {
    if (!open) return
    function onDown(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  function markAll() {
    const next = new Set(read)
    notes.forEach((note) => next.add(note.id))
    setRead(next)
    localStorage.setItem(READ_KEY, JSON.stringify([...next]))
  }

  function openNote(note: Note) {
    const next = new Set(read).add(note.id)
    setRead(next)
    localStorage.setItem(READ_KEY, JSON.stringify([...next]))
    setOpen(false)
    navigate(note.to)
  }

  const label = unread.length
    ? `Notifications, ${plural(unread.length, 'unread item', 'unread items')}`
    : 'Notifications'

  return (
    <div className="bell-wrap" ref={wrapRef}>
      <button
        className={`icon-btn bell${unread.length ? ' bell-lit' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-expanded={open}
        title={label}
      >
        <IconBell size={18} />
        {unread.length > 0 && <span className="bell-dot">{unread.length}</span>}
      </button>

      {open && (
        <div className="popover" role="dialog" aria-label="Notifications">
          <div className="popover-head">
            <span className="popover-title">Notifications</span>
            {unread.length > 0 && (
              <button className="link-btn" onClick={markAll}>
                <IconCheck size={14} /> Mark all read
              </button>
            )}
          </div>

          {notes.length === 0 ? (
            <p className="notes-empty">
              Nothing needs attention. Approvals, seat limits and billing show up here.
            </p>
          ) : (
            <ul className="notes-list">
              {notes.map((note) => {
                const Glyph = TONE_ICON[note.tone]
                return (
                  <li key={note.id}>
                    <button
                      className={`note note-${note.tone}${read.has(note.id) ? ' note-read' : ''}`}
                      onClick={() => openNote(note)}
                    >
                      <span className="note-glyph"><Glyph size={15} /></span>
                      <span className="note-body">
                        <span className="note-title">{note.title}</span>
                        <span className="note-text">{note.body}</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
