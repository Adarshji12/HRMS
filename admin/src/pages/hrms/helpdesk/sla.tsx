/* SLA: how fast a priority should be answered and resolved, how that reads on a ticket, and the staff editor for it. */

import { useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { ErrorNote } from '../../../components/ui'
import { Dialog } from '../../crm/parts'

export interface SlaRow { priority: string; respond_minutes: number; resolve_minutes: number }

/** Highest urgency first: P1 to P4. */
export const SLA_ORDER = ['urgent', 'high', 'normal', 'low'] as const

export function useSla() {
  const q = useQuery<{ rows: SlaRow[] }>('hd-sla', () => api.get<{ rows: SlaRow[] }>('/helpdesk/sla'))
  const byPriority = Object.fromEntries((q.data?.rows ?? []).map((r) => [r.priority, r])) as Record<string, SlaRow | undefined>
  return { ...q, byPriority }
}

/** 15 -> "15 mins", 240 -> "4 hours", 2880 -> "2 days". */
export function minutesText(minutes: number): string {
  if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'}`
  if (minutes < 60 * 24) {
    const h = minutes / 60
    return Number.isInteger(h) ? `${h} hour${h === 1 ? '' : 's'}` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  }
  const d = minutes / (60 * 24)
  return Number.isInteger(d) ? `${d} day${d === 1 ? '' : 's'}` : `${Math.floor(minutes / 60)} hours`
}

function span(ms: number): string {
  const m = Math.max(1, Math.round(Math.abs(ms) / 60000))
  if (m < 60) return `${m}m`
  if (m < 60 * 24) return `${Math.floor(m / 60)}h ${m % 60}m`
  return `${Math.floor(m / (60 * 24))}d ${Math.floor((m % (60 * 24)) / 60)}h`
}

export interface SlaState { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }

/** One deadline against what has happened: met, missed, still running, or overdue. Null when the ticket carries no deadline. */
export function slaState(due: string | null | undefined, doneAt: string | null | undefined, startedAt: string): SlaState | null {
  if (!due) return null
  const dueMs = new Date(due).getTime()
  if (doneAt) {
    const done = new Date(doneAt).getTime()
    return done <= dueMs
      ? { text: `Met in ${span(done - new Date(startedAt).getTime())}`, tone: 'ok' }
      : { text: `Missed by ${span(done - dueMs)}`, tone: 'bad' }
  }
  const left = dueMs - Date.now()
  if (left < 0) return { text: `Overdue ${span(left)}`, tone: 'bad' }
  return { text: `Due in ${span(left)}`, tone: left < 30 * 60000 ? 'warn' : 'muted' }
}

/** The two SLA lines on a ticket: first response and resolution. Nothing renders for a ticket with no deadlines. */
export function SlaChips({ ticket }: { ticket: { created_at: string; status: string; respond_by?: string | null; resolve_by?: string | null; first_response_at?: string | null; resolved_at?: string | null; closed_at?: string | null } }) {
  const finished = ticket.resolved_at ?? ticket.closed_at ?? null
  const respond = slaState(ticket.respond_by, ticket.first_response_at, ticket.created_at)
  const resolve = slaState(ticket.resolve_by, finished, ticket.created_at)
  if (!respond && !resolve) return null
  return (
    <div className="hd-sla-chips">
      {respond && <span className={`hd-sla hd-sla-${respond.tone}`}><em>First response</em>{respond.text}</span>}
      {resolve && <span className={`hd-sla hd-sla-${resolve.tone}`}><em>Resolution</em>{resolve.text}</span>}
    </div>
  )
}

/** True when an open ticket has already run past one of its deadlines: for a flag in a list row. */
export function isBreached(ticket: { status: string; respond_by?: string | null; resolve_by?: string | null; first_response_at?: string | null }): boolean {
  if (ticket.status === 'closed' || ticket.status === 'resolved') return false
  const now = Date.now()
  const lateReply = !ticket.first_response_at && ticket.respond_by && new Date(ticket.respond_by).getTime() < now
  const lateFix = ticket.resolve_by && new Date(ticket.resolve_by).getTime() < now
  return Boolean(lateReply || lateFix)
}

const UNITS = [['mins', 1], ['hours', 60], ['days', 1440]] as const

function split(minutes: number): { n: string; unit: number } {
  for (const [, size] of [...UNITS].reverse()) if (minutes % size === 0) return { n: String(minutes / size), unit: size }
  return { n: String(minutes), unit: 1 }
}

/** The SLA table, for helpdesk staff: first-response and resolution time per priority. */
export function SlaSettings({ onClose }: { onClose: () => void }) {
  const sla = useSla()
  const [draft, setDraft] = useState<Record<string, { rn: string; ru: number; sn: string; su: number }> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rows = draft ?? Object.fromEntries(SLA_ORDER.map((p) => {
    const r = sla.byPriority[p]
    const a = split(r?.respond_minutes ?? 0)
    const b = split(r?.resolve_minutes ?? 0)
    return [p, { rn: a.n, ru: a.unit, sn: b.n, su: b.unit }]
  }))
  const set = (p: string, patch: Partial<{ rn: string; ru: number; sn: string; su: number }>) => setDraft({ ...rows, [p]: { ...rows[p], ...patch } })
  const minutes = (n: string, unit: number) => Math.round(Number(n) * unit)
  const valid = SLA_ORDER.every((p) => {
    const r = rows[p]
    return Number(r.rn) > 0 && Number(r.sn) > 0 && minutes(r.sn, r.su) >= minutes(r.rn, r.ru)
  })

  async function save() {
    setBusy(true); setError(null)
    try {
      await api.put('/helpdesk/sla', {
        rows: SLA_ORDER.map((p) => ({ priority: p, respond_minutes: minutes(rows[p].rn, rows[p].ru), resolve_minutes: minutes(rows[p].sn, rows[p].su) })),
      })
      sla.reload()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the SLA')
      setBusy(false)
    }
  }

  const P: Record<string, string> = { urgent: 'P1 - Critical', high: 'P2 - High', normal: 'P3 - Normal', low: 'P4 - Low' }
  return (
    <Dialog title="SLA targets" subtitle="How quickly each priority should get a first reply and be resolved. Plain clock time. Applies to tickets raised from now on." wide onClose={onClose}
            footer={<>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !valid} onClick={() => void save()}>{busy ? 'Saving...' : 'Save SLA'}</button>
            </>}>
      <div className="hd-sla-edit">
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="hd-sla-head"><span>Priority</span><span>First response within</span><span>Resolve within</span></div>
        {SLA_ORDER.map((p) => (
          <div key={p} className="hd-sla-row">
            <b>{P[p]}</b>
            <span><input type="number" min={1} value={rows[p].rn} onChange={(e) => set(p, { rn: e.target.value })} />
              <select value={rows[p].ru} onChange={(e) => set(p, { ru: Number(e.target.value) })}>{UNITS.map(([l, s]) => <option key={l} value={s}>{l}</option>)}</select></span>
            <span><input type="number" min={1} value={rows[p].sn} onChange={(e) => set(p, { sn: e.target.value })} />
              <select value={rows[p].su} onChange={(e) => set(p, { su: Number(e.target.value) })}>{UNITS.map(([l, s]) => <option key={l} value={s}>{l}</option>)}</select></span>
          </div>
        ))}
        {!valid && <p className="hd-sla-bad">Every figure must be above zero, and resolution cannot be due before the first response.</p>}
      </div>
    </Dialog>
  )
}
