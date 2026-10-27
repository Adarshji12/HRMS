/* Lead Dashboard — pipeline health, in one screen and one request.
 *
 * Every number here comes from `/crm/dashboard`, which aggregates server-side.
 * That is the point: eight separate calls would let the tiles and the funnel
 * describe two different moments while they landed, and a dashboard whose
 * halves disagree is worse than one that is a second out of date.
 *
 * The tiles that count *work owed* — follow-ups due, overdue, pending — are
 * deliberately not filtered by the date range. Work owed today is owed whether
 * or not the lead came in this month, and having those numbers move when
 * somebody changes the range is how a salesperson learns to distrust them.
 *
 * Reading order, top to bottom: one toolbar that scopes everything, the
 * overview (one hero figure, three supporting ones), what needs doing now, how
 * the range moved, where the leads sit and came from, and who holds them.
 * Colour is spent on meaning only — status on the attention strip and the
 * outcome meters, one series hue everywhere else. A stage's own colour stays a
 * dot beside its name, so twelve stages cannot turn the funnel into a paint
 * chart. */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import '../../styles/crm.css'
import '../../styles/hrdash.css'
import { useQuery } from '../../lib/useQuery'
import { Avatar, ErrorNote, Loading } from '../../components/ui'
import {
  IconAlert,
  IconChart,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconClose,
  IconFilter,
  IconGauge,
  IconPlus,
  IconReturn,
  IconStar,
  IconUsers,
} from '../../components/Icons'
import {
  crm,
  crmError,
  daysFromTodayISO,
  todayISO,
  type LeadDashboard as Dashboard,
  type TrendPoint,
} from './api'
import { MasterSelect, OwnerSelect } from './parts'

const RANGES: Array<{ key: string; short: string; label: string; days: number }> = [
  { key: '7', short: '7D', label: 'Last 7 days', days: 6 },
  { key: '30', short: '30D', label: 'Last 30 days', days: 29 },
  { key: '90', short: '90D', label: 'Last 90 days', days: 89 },
  { key: '365', short: '12M', label: 'Last 12 months', days: 364 },
]

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const fmt = (n: number) => (Math.abs(n) >= 10000 ? compact.format(n) : n.toLocaleString())

const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/** `overview`: shown from the main Dashboard, where the date line and the
 *  shortcuts into CRM help. Inside CRM the sidebar already carries both. */
export default function LeadDashboard({ overview = false }: { overview?: boolean }) {
  const [range, setRange] = useState('30')
  const [ownerId, setOwnerId] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [statusId, setStatusId] = useState('')

  const selected = RANGES.find((r) => r.key === range) ?? RANGES[1]
  const from = daysFromTodayISO(-selected.days)
  const to = todayISO()

  const data = useQuery<Dashboard>(
    `crm-dashboard-${range}-${ownerId}-${sourceId}-${statusId}`,
    () =>
      crm.dashboard({
        date_from: from,
        date_to: to,
        owner_id: ownerId || undefined,
        source_id: sourceId || undefined,
        status_id: statusId || undefined,
      }),
  )

  const filtered = ownerId !== '' || sourceId !== '' || statusId !== ''
  const d = data.data

  // Same card as the HR Dashboard's KPI row: label, icon, figure, one line of
  // context, a coloured spine. The follow-up counts only turn red or amber
  // when there is something to act on — a red zero is an alarm about nothing.
  const kpis: Array<{ label: string; value: ReactNode; hint: string; tone: string; to?: string; icon: ReactNode }> = d
    ? [
        { label: 'Total leads', value: fmt(d.total_leads), hint: `${fmt(d.total_leads_all_time)} all time`, tone: 'brand', to: '/crm/leads', icon: <IconUsers size={16} /> },
        { label: 'New leads', value: fmt(d.new_leads), hint: `Created · ${selected.label.toLowerCase()}`, tone: 'good', to: '/crm/leads', icon: <IconPlus size={16} /> },
        { label: 'Converted', value: fmt(d.converted_leads), hint: `${fmt(d.qualified_leads)} qualified`, tone: 'good', icon: <IconCheck size={16} /> },
        { label: 'Conversion rate', value: `${d.conversion_rate}%`, hint: `${fmt(d.converted_leads)} of ${fmt(d.total_leads)} leads`, tone: 'brand', icon: <IconGauge size={16} /> },
        { label: 'Overdue follow-ups', value: fmt(d.overdue_follow_ups), hint: 'Past their due time', tone: d.overdue_follow_ups > 0 ? 'bad' : 'idle', to: '/crm/follow-ups?window=overdue', icon: <IconAlert size={16} /> },
        { label: 'Due today', value: fmt(d.follow_ups_due_today), hint: 'Follow-ups for today', tone: d.follow_ups_due_today > 0 ? 'warn' : 'idle', to: '/crm/follow-ups?window=today', icon: <IconReturn size={16} /> },
        { label: 'Pending follow-ups', value: fmt(d.pending_follow_ups), hint: 'Open, not yet done', tone: 'idle', to: '/crm/follow-ups', icon: <IconClock size={16} /> },
        { label: 'Leads today', value: fmt(d.todays_leads), hint: 'Created since midnight', tone: 'brand', to: '/crm/leads', icon: <IconStar size={16} /> },
      ]
    : []

  return (
    <div className="crm hrd">
      <header className="hrd-hero">
        <div className="hrd-hero-text">
          {overview && (
            <span className="hrd-eyebrow">
              CRM · {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </span>
          )}
          <h1 className="hrd-title">Lead Dashboard</h1>
        </div>
        {overview && (
          <div className="hrd-hero-actions">
            <Link className="btn" to="/crm/follow-ups">
              Follow-ups
              {(d?.overdue_follow_ups ?? 0) > 0 && <span className="hrd-pill-count">{d!.overdue_follow_ups}</span>}
            </Link>
            <Link className="btn btn-primary" to="/crm/leads">
              <IconUsers size={15} /> Open leads
            </Link>
          </div>
        )}
      </header>

      {/* One toolbar, above everything it scopes: what to look at on the left,
          over what period on the right. */}
      <div className="ld-toolbar">
        <span className="ld-toolbar-label"><IconFilter size={15} /> Filter</span>
        <MasterSelect kind="statuses" value={statusId} onChange={setStatusId} placeholder="All statuses" />
        <MasterSelect kind="sources" value={sourceId} onChange={setSourceId} placeholder="All sources" />
        <OwnerSelect value={ownerId} onChange={setOwnerId} placeholder="All users" />
        {filtered && (
          <button
            className="filter-reset"
            onClick={() => {
              setOwnerId('')
              setSourceId('')
              setStatusId('')
            }}
          >
            Clear
          </button>
        )}
        <span className="ld-toolbar-end ld-range-note">{dayLabel(from)} – {dayLabel(to)}</span>
        <div className="ld-segment" role="radiogroup" aria-label="Date range">
          {RANGES.map((option) => (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={option.key === range}
              title={option.label}
              className={option.key === range ? 'is-on' : undefined}
              onClick={() => setRange(option.key)}
            >
              {option.short}
            </button>
          ))}
        </div>
      </div>

      {data.error ? (
        <ErrorNote>{crmError(data.cause, 'Could not load the dashboard')}</ErrorNote>
      ) : !d ? (
        <Loading label="Reading the pipeline…" />
      ) : (
        // Held at reduced opacity on refetch rather than swapped for a
        // skeleton, so changing a filter does not make the page jump.
        <div className="ld" style={{ opacity: data.refetching ? 0.55 : 1 }}>
          <div className="hrd-kpis ld-kpis" role="group" aria-label="Lead summary">
            {kpis.map((k) => {
              const body = (
                <>
                  <span className="hrd-kpi-top">
                    <span className="hrd-kpi-label">{k.label}</span>
                    <span className="hrd-kpi-icon" aria-hidden>{k.icon}</span>
                  </span>
                  <span className="hrd-kpi-value">{k.value}</span>
                  <span className="hrd-kpi-hint">{k.hint}</span>
                </>
              )
              return k.to
                ? <Link key={k.label} to={k.to} className={`hrd-kpi tone-${k.tone}`}>{body}</Link>
                : <div key={k.label} className={`hrd-kpi tone-${k.tone}`}>{body}</div>
            })}
          </div>

          <div className="ld-row ld-row-wide">
            <TrendCard points={d.trend} />

            <section className="card ld-panel">
              <PanelHead title="Outcomes" note={`Share of ${fmt(d.total_leads)} leads`} />
              <div className="ld-outcomes">
                <Outcome icon={<IconStar size={14} />} label="Qualified" value={d.qualified_leads} total={d.total_leads} tone="neutral" />
                <Outcome icon={<IconCheck size={14} />} label="Converted" value={d.converted_leads} total={d.total_leads} tone="good" />
                <Outcome icon={<IconClose size={14} />} label="Lost" value={d.lost_leads} total={d.total_leads} tone="bad" />
              </div>
            </section>
          </div>

          <div className="ld-row">
            <section className="card ld-panel">
              <PanelHead
                title="Lead status funnel"
                note="Where the range's leads stand"
                action={<Link className="ld-link" to="/crm/leads">View leads <IconChevronRight size={14} /></Link>}
              />
              <div className="ld-bars">
                <div className="ld-bars-head" aria-hidden>
                  <span>Stage</span><span /><span>Leads</span><span>Share</span>
                </div>
                {d.funnel.length === 0 && <Empty>No stages configured yet.</Empty>}
                {d.funnel.map((stage) => (
                  <Bar
                    key={stage.status_id ?? stage.name}
                    label={<><span className="crm-pill-dot" style={{ background: stage.colour }} />{stage.name}</>}
                    title={stage.name}
                    // A stage with leads in it always draws something: a 0.3%
                    // bar rounded to nothing reads as an empty stage.
                    width={stage.count > 0 ? Math.max(2, stage.percent) : 0}
                    value={fmt(stage.count)}
                    note={`${stage.percent}%`}
                  />
                ))}
              </div>
            </section>

            <section className="card ld-panel">
              <PanelHead title="Lead sources" note="Where the range's leads came from" />
              <div className="ld-bars">
                {d.sources.length > 0 && (
                  <div className="ld-bars-head" aria-hidden>
                    <span>Source</span><span /><span>Leads</span><span>Converts</span>
                  </div>
                )}
                {d.sources.length === 0 && <Empty icon={<IconChart size={18} />}>No leads came in during this range.</Empty>}
                {(() => {
                  const peak = Math.max(...d.sources.map((s) => s.count), 1)
                  return d.sources.map((source) => (
                    <Bar
                      key={source.name}
                      label={source.name}
                      title={source.name}
                      width={source.count > 0 ? Math.max(2, (source.count / peak) * 100) : 0}
                      value={fmt(source.count)}
                      note={`${source.conversion_rate}%`}
                    />
                  ))
                })()}
              </div>
            </section>
          </div>

          <section className="card ld-panel">
            <PanelHead title="Team performance" note="Across the whole pipeline, not the range" />
            {d.owners.length === 0 ? (
              <Empty icon={<IconUsers size={18} />}>Nobody owns a lead yet. Assign leads to see each person's numbers here.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="ld-team">
                  <thead>
                    <tr>
                      <th style={{ width: 56 }}>Rank</th>
                      <th>Owner</th>
                      <th className="crm-num">Leads</th>
                      <th className="crm-num">Converted</th>
                      <th className="crm-num">Pending follow-ups</th>
                      <th style={{ width: '26%' }}>Conversion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.owners.map((owner, index) => (
                      <tr key={owner.owner_id ?? 'unassigned'}>
                        <td><span className={`ld-rank${index < 3 && owner.owner_id ? ' is-top' : ''}`}>{index + 1}</span></td>
                        <td>
                          <span className="ld-person">
                            {owner.owner_id ? <Avatar name={owner.name} small /> : <span className="ld-avatar-empty" aria-hidden />}
                            <span className={owner.owner_id ? 'crm-strong' : 'crm-muted'}>{owner.name}</span>
                          </span>
                        </td>
                        <td className="crm-num">{fmt(owner.total)}</td>
                        <td className="crm-num">{fmt(owner.converted)}</td>
                        <td className="crm-num">
                          {owner.pending_follow_ups > 0
                            ? <span className="ld-pending">{fmt(owner.pending_follow_ups)}</span>
                            : <span className="crm-muted">—</span>}
                        </td>
                        <td>
                          <span className="ld-meter-row">
                            <span className="ld-meter" aria-hidden>
                              <span style={{ width: `${Math.min(100, owner.conversion_rate)}%` }} />
                            </span>
                            <span className="ld-meter-value">{owner.conversion_rate}%</span>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- the pieces --- */

function PanelHead({ title, note, action }: { title: string; note?: string; action?: ReactNode }) {
  return (
    <div className="ld-panel-head">
      <div className="ld-panel-titles">
        <h2 className="ld-panel-title">{title}</h2>
        {note && <p className="ld-panel-note">{note}</p>}
      </div>
      {action && <div className="ld-panel-action">{action}</div>}
    </div>
  )
}

function Empty({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="ld-empty">
      {icon && <span className="ld-empty-icon" aria-hidden>{icon}</span>}
      <span>{children}</span>
    </div>
  )
}

function Outcome({
  icon,
  label,
  value,
  total,
  tone,
}: {
  icon: ReactNode
  label: string
  value: number
  total: number
  tone: 'good' | 'bad' | 'neutral'
}) {
  const share = total > 0 ? Math.round((value / total) * 1000) / 10 : 0
  return (
    <div className={`ld-outcome is-${tone}`}>
      <div className="ld-outcome-top">
        <span className="ld-outcome-label"><span className="ld-outcome-icon" aria-hidden>{icon}</span>{label}</span>
        <span className="ld-outcome-value">{fmt(value)}</span>
      </div>
      <div className="ld-outcome-bar">
        <span className="ld-meter" aria-hidden>
          <span style={{ width: `${Math.min(100, share)}%` }} />
        </span>
        <span className="ld-outcome-share">{share}%</span>
      </div>
    </div>
  )
}

function Bar({
  label,
  title,
  width,
  value,
  note,
}: {
  label: ReactNode
  title: string
  width: number
  value: string
  note: string
}) {
  return (
    <div className="ld-bar">
      <span className="ld-bar-label" title={title}>{label}</span>
      <span className="ld-bar-track"><span className="ld-bar-fill" style={{ width: `${width}%` }} /></span>
      <span className="ld-bar-value">{value}</span>
      <span className="ld-bar-note">{note}</span>
    </div>
  )
}

/* --------------------------------------------------------------- the chart --- */

function TrendCard({ points }: { points: TrendPoint[] }) {
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const totals = points.reduce(
    (sum, p) => ({ added: sum.added + p.new_leads, won: sum.won + p.converted }),
    { added: 0, won: 0 },
  )
  return (
    <section className="card ld-panel">
      <PanelHead
        title="Lead trend"
        note="New and converted leads per day"
        action={
          <div className="ld-segment ld-segment-sm" role="radiogroup" aria-label="Trend view">
            {(['chart', 'table'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={view === v}
                className={view === v ? 'is-on' : undefined}
                onClick={() => setView(v)}
              >
                {v === 'chart' ? 'Chart' : 'Table'}
              </button>
            ))}
          </div>
        }
      />
      <div className="ld-legend">
        <span className="ld-legend-item"><span className="ld-swatch ld-swatch-new" />New leads <b>{fmt(totals.added)}</b></span>
        <span className="ld-legend-item"><span className="ld-swatch ld-swatch-won" />Converted <b>{fmt(totals.won)}</b></span>
      </div>
      {view === 'chart' ? (
        <div className="ld-chart"><TrendChart points={points} empty={totals.added + totals.won === 0} /></div>
      ) : (
        <div className="table-wrap ld-trend-table">
          <table>
            <thead>
              <tr><th>Day</th><th className="crm-num">New</th><th className="crm-num">Converted</th></tr>
            </thead>
            <tbody>
              {[...points].reverse().map((p) => (
                <tr key={p.day}>
                  <td>{dayLabel(p.day)}</td>
                  <td className="crm-num">{p.new_leads}</td>
                  <td className="crm-num">{p.converted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** Measures its box so the SVG is drawn at real pixels: a viewBox scaled to
 *  fit shrank the axis text to seven pixels on a laptop screen. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

/** Two series over the same days: leads in, and leads won.
 *
 * Written here rather than reusing `components/charts` because none of those
 * take two series, and the comparison *is* the chart. One y-axis: both are
 * counts of leads. Every day in the range is a point, including the empty ones:
 * a chart that skips quiet days draws a busy week and a quiet week identically. */
function TrendChart({ points, empty }: { points: TrendPoint[]; empty: boolean }) {
  const [ref, measured] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const W = Math.max(320, measured)
  const H = 200

  const geometry = useMemo(() => {
    const padL = 40
    const padR = 16
    const padT = 16
    const padB = 32
    const plotW = W - padL - padR
    const plotH = H - padT - padB
    const peak = Math.max(...points.map((p) => Math.max(p.new_leads, p.converted)), 0)
    // A round top so the ticks land on whole, readable numbers.
    const unit = peak <= 4 ? 1 : Math.pow(10, Math.floor(Math.log10(peak)))
    const max = Math.max(4, Math.ceil(peak / unit) * unit)
    const step = points.length > 1 ? plotW / (points.length - 1) : plotW
    const x = (index: number) => padL + index * step
    const y = (value: number) => padT + plotH - (value / max) * plotH
    return { padL, padR, padT, padB, plotW, plotH, max, x, y }
  }, [points, W])

  if (points.length === 0) return <Empty>No days in this range.</Empty>

  const { padL, padR, padT, padB, plotW, plotH, max, x, y } = geometry
  const line = (pick: (p: TrendPoint) => number) =>
    points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(index).toFixed(1)} ${y(pick(point)).toFixed(1)}`).join(' ')
  const area = `${line((p) => p.new_leads)} L ${x(points.length - 1)} ${padT + plotH} L ${padL} ${padT + plotH} Z`
  const ticks = [...new Set([0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f)))]

  // Labels no closer than ~70px, so a 365-day range is not a wall of dates.
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotW / 70))))
  const last = points.length - 1

  return (
    <div ref={ref} className="ld-chart-box">
      {measured > 0 && (
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="New and converted leads per day"
          onMouseLeave={() => setHover(null)}
          style={{ display: 'block' }}
        >
          <defs>
            <linearGradient id="ld-area" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--ld-new)" stopOpacity={0.2} />
              <stop offset="100%" stopColor="var(--ld-new)" stopOpacity={0} />
            </linearGradient>
          </defs>

          {ticks.map((value) => (
            <g key={value}>
              <line className={value === 0 ? 'baseline' : 'gridline'} x1={padL} x2={W - padR} y1={y(value)} y2={y(value)} />
              <text className="ld-axis" x={padL - 10} y={y(value) + 4} textAnchor="end">{value}</text>
            </g>
          ))}

          {!empty && (
            <>
              <path d={area} fill="url(#ld-area)" />
              <path d={line((p) => p.new_leads)} fill="none" stroke="var(--ld-new)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              <path d={line((p) => p.converted)} fill="none" stroke="var(--status-good)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {hover === null && (
                <>
                  <circle cx={x(last)} cy={y(points[last].new_leads)} r={4} fill="var(--ld-new)" stroke="var(--surface-1)" strokeWidth={2} />
                  <circle cx={x(last)} cy={y(points[last].converted)} r={4} fill="var(--status-good)" stroke="var(--surface-1)" strokeWidth={2} />
                </>
              )}
            </>
          )}

          {points.map((point, index) => (
            <g key={point.day}>
              {/* A full-height hit strip: a 2px line is not a target anybody
                  can hit with a mouse. */}
              {!empty && (
                <rect
                  x={x(index) - plotW / points.length / 2}
                  y={padT}
                  width={Math.max(8, plotW / points.length)}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setHover(index)}
                />
              )}
              {hover === index && (
                <>
                  <line x1={x(index)} x2={x(index)} y1={padT} y2={padT + plotH} stroke="var(--border-strong)" />
                  <circle cx={x(index)} cy={y(point.new_leads)} r={4.5} fill="var(--ld-new)" stroke="var(--surface-1)" strokeWidth={2} />
                  <circle cx={x(index)} cy={y(point.converted)} r={4.5} fill="var(--status-good)" stroke="var(--surface-1)" strokeWidth={2} />
                </>
              )}
              {(index % labelEvery === 0) && (
                <text className="ld-axis" x={x(index)} y={H - padB + 22} textAnchor="middle">
                  {dayLabel(point.day)}
                </text>
              )}
            </g>
          ))}
        </svg>
      )}

      {empty && (
        <div className="ld-chart-empty">
          <span className="ld-empty-icon" aria-hidden><IconChart size={18} /></span>
          <b>No leads in this range</b>
          <span>New and converted leads will draw here day by day.</span>
        </div>
      )}

      {hover !== null && (
        <div
          className="tooltip ld-tooltip"
          style={{ left: Math.min(Math.max(x(hover), 90), W - 90) }}
        >
          <div className="tooltip-title">{dayLabel(points[hover].day)}</div>
          <div className="tooltip-row">
            <span><span className="ld-swatch ld-swatch-new" />New leads</span>
            <strong>{points[hover].new_leads}</strong>
          </div>
          <div className="tooltip-row">
            <span><span className="ld-swatch ld-swatch-won" />Converted</span>
            <strong>{points[hover].converted}</strong>
          </div>
        </div>
      )}
    </div>
  )
}
