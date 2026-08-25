import { useMemo, useState } from 'react'
import '../styles/org.css'
import '../styles/timesheets.css'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { useAuth } from '../lib/auth'
import { daysAgoISO, duration, hours, todayISO } from '../lib/format'
import { DailyBars, RankedBars } from '../components/charts'
import { ChartCard } from '../components/ChartCard'
import { ErrorNote, Loading, Meter, StatTile } from '../components/ui'
import { ExportButton } from '../components/ExportButton'
import type { Breakdown, DailyPoint, Totals } from '../lib/types'

/**
 * The employee's own view of their own work.
 *
 * Everything else in this console is an administrator's lens that happens to
 * narrow to one person when an employee signs in — the Dashboard still counts
 * "Employees: 1" at them. This page is written the other way round: it assumes
 * the subject is the reader, so it can compare them to *themselves* rather than
 * rank them against colleagues they are not allowed to see.
 *
 * It calls the same self-scoping report endpoint everyone else uses. No new
 * permission surface: an employee already had the right to these numbers, they
 * just had nowhere sensible to read them.
 */

interface Summary {
  start: string
  end: string
  timezone: string
  totals: Totals
  daily: DailyPoint[]
  top_apps: Breakdown[]
  top_domains: Breakdown[]
}

type Span = 7 | 14 | 30

const SPANS: Array<{ id: Span; label: string }> = [
  { id: 7, label: 'Last 7 days' },
  { id: 14, label: 'Last 14 days' },
  { id: 30, label: 'Last 30 days' },
]

function pct(value: number, of: number): number {
  return of > 0 ? (value / of) * 100 : 0
}

/** "+12%" / "−4%" against the previous window of the same length. */
function Delta({ now, before, invert }: { now: number; before: number; invert?: boolean }) {
  if (before <= 0) return <span className="muted-sm">no earlier data</span>
  const change = ((now - before) / before) * 100
  if (Math.abs(change) < 0.5) return <span className="delta delta-flat">no change</span>
  const better = invert ? change < 0 : change > 0
  return (
    <span className={`delta ${better ? 'delta-up' : 'delta-down'}`}>
      {change > 0 ? '▲' : '▼'} {Math.abs(change).toFixed(0)}% vs previous
    </span>
  )
}

export default function MyPerformance() {
  const { user } = useAuth()
  const [span, setSpan] = useState<Span>(7)

  const end = todayISO()
  const start = daysAgoISO(span - 1)
  // The window immediately before this one, same length — the only fair
  // comparison when the spans are user-selectable.
  const prevEnd = daysAgoISO(span)
  const prevStart = daysAgoISO(span * 2 - 1)

  const scope = user ? `&user_id=${user.id}` : ''
  const current = useQuery<Summary>(
    `me:${span}:${user?.id ?? ''}`,
    () => api.get<Summary>(`/admin/reports/summary?start=${start}&end=${end}${scope}`),
    { enabled: !!user },
  )
  const previous = useQuery<Summary>(
    `me-prev:${span}:${user?.id ?? ''}`,
    () => api.get<Summary>(`/admin/reports/summary?start=${prevStart}&end=${prevEnd}${scope}`),
    { enabled: !!user },
  )

  const best = useMemo(() => {
    const days = current.data?.daily ?? []
    if (days.length === 0) return null
    return days.reduce((a, b) => (b.tracked_s > a.tracked_s ? b : a))
  }, [current.data])

  const daysWorked = (current.data?.daily ?? []).filter((d) => d.tracked_s > 0).length

  if (current.error) return <ErrorNote>{current.error}</ErrorNote>
  if (current.loading || !current.data) return <Loading />

  const t = current.data.totals
  const prev = previous.data?.totals
  const productivity = pct(t.productive_s, t.productive_s + t.unproductive_s + t.neutral_s)
  const activeShare = pct(t.active_s, t.tracked_s)
  const avgPerWorkedDay = daysWorked > 0 ? t.tracked_s / daysWorked : 0

  return (
    <div className={current.refetching ? 'refetching' : undefined}>
      <div className="page-head">
        <div>
          <h1 className="page-title">My performance</h1>
          <p className="page-sub">
            {user?.full_name} · {current.data.start} → {current.data.end} · times in{' '}
            {current.data.timezone}. Only you and the people who manage you can see this.
          </p>
        </div>
        <div className="head-actions">
          <ExportButton
            href={`/admin/reports/export.csv?start=${start}&end=${end}&user_id=${user?.id ?? ''}`}
            filename={`my-activity-${start}-to-${end}.csv`}
            disabled={!user || t.tracked_s === 0}
          />
        </div>
      </div>

      <div className="filter-row">
        <div className="ts-toggle" role="group" aria-label="Period">
          {SPANS.map((s) => (
            <button
              key={s.id}
              className={`ts-toggle-btn ${span === s.id ? 'ts-toggle-on' : ''}`}
              onClick={() => setSpan(s.id)}
              aria-pressed={span === s.id}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-tiles">
        <StatTile
          label="Tracked"
          value={duration(t.tracked_s)}
          meta={<Delta now={t.tracked_s} before={prev?.tracked_s ?? 0} />}
        />
        <StatTile
          label="Active"
          value={duration(t.active_s)}
          meta={`${activeShare.toFixed(0)}% of tracked · ${hours(t.active_s)} h`}
        />
        <StatTile
          label="Productivity"
          value={`${productivity.toFixed(0)}%`}
          accent="var(--prod)"
          meta={<Delta now={productivity} before={pct(prev?.productive_s ?? 0,
            (prev?.productive_s ?? 0) + (prev?.unproductive_s ?? 0) + (prev?.neutral_s ?? 0))} />}
        />
        <StatTile
          label="Idle"
          value={duration(t.idle_s)}
          meta={<Delta now={t.idle_s} before={prev?.idle_s ?? 0} invert />}
        />
        <StatTile
          label="Days worked"
          value={String(daysWorked)}
          meta={`of ${span} · ${duration(avgPerWorkedDay)}/day average`}
        />
        <StatTile
          label="Best day"
          value={best && best.tracked_s > 0 ? duration(best.tracked_s) : '—'}
          meta={best && best.tracked_s > 0 ? best.date : 'nothing tracked yet'}
        />
      </div>

      {/* How the time split, as one bar rather than three tiles: the shares are
          the story, and shares belong side by side. */}
      <section className="card" style={{ marginTop: 14 }}>
        <div className="card-head">
          <h2 className="card-title">How your time classified</h2>
          <span className="card-note">{duration(t.tracked_s)} tracked</span>
        </div>
        <dl className="kv">
          <div>
            <dt>Productive</dt>
            <dd>{duration(t.productive_s)} · {pct(t.productive_s, t.tracked_s).toFixed(0)}%</dd>
          </div>
          <div>
            <dt>Neutral</dt>
            <dd>{duration(t.neutral_s)} · {pct(t.neutral_s, t.tracked_s).toFixed(0)}%</dd>
          </div>
          <div>
            <dt>Unproductive</dt>
            <dd>{duration(t.unproductive_s)} · {pct(t.unproductive_s, t.tracked_s).toFixed(0)}%</dd>
          </div>
          <div>
            <dt>Idle</dt>
            <dd>{duration(t.idle_s)} · {pct(t.idle_s, t.tracked_s).toFixed(0)}%</dd>
          </div>
        </dl>
        <div style={{ marginTop: 12 }}>
          <Meter value={t.productive_s} max={Math.max(1, t.tracked_s)} accent="var(--prod)" />
        </div>
      </section>

      <ChartCard
        title="Your daily pattern"
        note={`${current.data.start} → ${current.data.end}`}
        table={
          <table>
            <thead>
              <tr><th>Date</th><th className="num">Tracked</th><th className="num">Active</th><th className="num">Productive</th></tr>
            </thead>
            <tbody>
              {current.data.daily.map((d) => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td className="num">{duration(d.tracked_s)}</td>
                  <td className="num">{duration(d.active_s)}</td>
                  <td className="num">{duration(d.productive_s)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        }
      >
        <DailyBars data={current.data.daily} />
      </ChartCard>

      <div className="grid grid-2" style={{ marginTop: 14 }}>
        <ChartCard title="Where your time went" note="applications">
          <RankedBars items={current.data.top_apps.slice(0, 8)} emptyLabel="No application activity yet" />
        </ChartCard>
        <ChartCard title="Sites you used most" note="domains">
          <RankedBars items={current.data.top_domains.slice(0, 8)} emptyLabel="No browsing recorded" />
        </ChartCard>
      </div>
    </div>
  )
}
