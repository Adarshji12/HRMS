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
 * somebody changes the range is how a salesperson learns to distrust them. */

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import '../../styles/crm.css'
import { useQuery } from '../../lib/useQuery'
import { ErrorNote, Loading } from '../../components/ui'
import {
  IconAlert,
  IconChart,
  IconCheck,
  IconClock,
  IconClose,
  IconFilter,
  IconGauge,
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
import { CrmPage, MasterSelect, OwnerSelect, Stat, Stats } from './parts'

const RANGES: Array<{ key: string; label: string; days: number }> = [
  { key: '7', label: 'Last 7 days', days: 6 },
  { key: '30', label: 'Last 30 days', days: 29 },
  { key: '90', label: 'Last 90 days', days: 89 },
  { key: '365', label: 'Last 12 months', days: 364 },
]

export default function LeadDashboard() {
  const [range, setRange] = useState('30')
  const [ownerId, setOwnerId] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [statusId, setStatusId] = useState('')

  const days = RANGES.find((r) => r.key === range)?.days ?? 29
  const from = daysFromTodayISO(-days)
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

  if (data.error) {
    return (
      <CrmPage title="Lead Dashboard">
        <ErrorNote>{crmError(data.cause, 'Could not load the dashboard')}</ErrorNote>
      </CrmPage>
    )
  }

  const d = data.data

  return (
    <CrmPage title="Lead Dashboard" subtitle="Pipeline health across your leads">
      <div className="crm-bar">
        <IconFilter size={16} />
        <select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Date range">
          {RANGES.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
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
            Clear filters
          </button>
        )}
        <span className="crm-push crm-sub">
          {from} → {to}
        </span>
      </div>

      {!d ? (
        <Loading label="Reading the pipeline…" />
      ) : (
        <div style={{ opacity: data.refetching ? 0.6 : 1 }}>
          <Stats>
            <Stat
              icon={<IconUsers size={16} />}
              label="Total Leads"
              value={d.total_leads}
              meta={`${d.total_leads_all_time} all time`}
            />
            <Stat
              icon={<IconStar size={16} />}
              label="New Leads"
              value={d.new_leads}
              meta="created in range"
            />
            <Stat icon={<IconClock size={16} />} label="Today's Leads" value={d.todays_leads} />
            <Stat
              icon={<IconReturn size={16} />}
              label="Due Today"
              value={d.follow_ups_due_today}
              meta="follow-ups"
              tone="var(--status-warn)"
              toned={d.follow_ups_due_today > 0}
              to="/crm/follow-ups?window=today"
            />
            <Stat
              icon={<IconClock size={16} />}
              label="Pending Follow-Ups"
              value={d.pending_follow_ups}
              meta="across the pipeline"
              to="/crm/follow-ups"
            />
            <Stat
              icon={<IconAlert size={16} />}
              label="Overdue"
              value={d.overdue_follow_ups}
              meta="follow-ups"
              tone="var(--status-critical)"
              toned={d.overdue_follow_ups > 0}
              to="/crm/follow-ups?window=overdue"
            />
            <Stat icon={<IconChart size={16} />} label="Qualified" value={d.qualified_leads} />
            <Stat
              icon={<IconCheck size={16} />}
              label="Converted"
              value={d.converted_leads}
              tone="var(--status-good)"
              toned={d.converted_leads > 0}
            />
            <Stat label="Lost Leads" value={d.lost_leads} icon={<IconClose size={16} />} />
            <Stat
              label="Conversion Rate"
              value={`${d.conversion_rate}%`}
              meta={`${d.converted_leads} of ${d.total_leads}`}
              icon={<IconGauge size={16} />}
            />
          </Stats>

          <section className="card" style={{ marginBottom: 14 }}>
            <div className="crm-panel-head">
              <h2 className="crm-panel-title">Date-Wise Lead Trend</h2>
              <div className="crm-panel-link legend">
                <span className="legend-item">
                  <span className="legend-swatch" style={{ background: 'var(--series-1)' }} />
                  New leads
                </span>
                <span className="legend-item">
                  <span className="legend-swatch" style={{ background: 'var(--status-good)' }} />
                  Converted
                </span>
              </div>
            </div>
            <div className="crm-trend">
              <TrendChart points={d.trend} />
            </div>
          </section>

          <div className="grid grid-2" style={{ marginBottom: 14 }}>
            <section className="card">
              <div className="crm-panel-head">
                <h2 className="crm-panel-title">Lead Status Funnel</h2>
                <Link className="crm-panel-link" to="/crm/leads">
                  View all →
                </Link>
              </div>
              <div className="crm-funnel">
                {d.funnel.length === 0 && <p className="empty">No stages configured yet.</p>}
                {d.funnel.map((stage) => (
                  <div className="crm-funnel-row" key={stage.status_id ?? stage.name}>
                    <span className="crm-funnel-label" title={stage.name}>
                      <span className="crm-pill-dot" style={{ background: stage.colour }} />
                      {stage.name}
                    </span>
                    <span className="crm-funnel-track">
                      <span
                        className="crm-funnel-fill"
                        style={{
                          // A stage with leads in it always draws something:
                          // a 0.3% bar rounded to nothing reads as an empty
                          // stage, which is a different fact.
                          width: `${stage.count > 0 ? Math.max(2, stage.percent) : 0}%`,
                          background: stage.colour,
                        }}
                      />
                    </span>
                    <span className="crm-funnel-value">
                      {stage.count} · {stage.percent}%
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className="card">
              <div className="crm-panel-head">
                <h2 className="crm-panel-title">Lead Source-Wise Analytics</h2>
              </div>
              <div className="crm-funnel">
                {d.sources.length === 0 && <p className="empty">No leads in this range.</p>}
                {d.sources.map((source) => {
                  const peak = Math.max(...d.sources.map((s) => s.count), 1)
                  return (
                    <div className="crm-funnel-row" key={source.name}>
                      <span className="crm-funnel-label" title={source.name}>
                        {source.name}
                      </span>
                      <span className="crm-funnel-track">
                        <span
                          className="crm-funnel-fill"
                          style={{
                            width: `${Math.max(2, (source.count / peak) * 100)}%`,
                            background: 'var(--series-3)',
                          }}
                        />
                      </span>
                      <span className="crm-funnel-value">
                        {source.count} · {source.conversion_rate}% conv.
                      </span>
                    </div>
                  )
                })}
              </div>
            </section>
          </div>

          <section className="card">
            <div className="crm-panel-head">
              <h2 className="crm-panel-title">User-Wise Lead Performance</h2>
              <span className="crm-panel-link crm-sub">across the whole pipeline, not the range</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>User</th>
                    <th className="crm-num">Leads</th>
                    <th className="crm-num">Converted</th>
                    <th className="crm-num">Pending follow-ups</th>
                    <th className="crm-num">Conversion</th>
                  </tr>
                </thead>
                <tbody>
                  {d.owners.length === 0 && (
                    <tr>
                      <td colSpan={5}>
                        <p className="empty">Nobody owns a lead yet.</p>
                      </td>
                    </tr>
                  )}
                  {d.owners.map((owner) => (
                    <tr key={owner.owner_id ?? 'unassigned'}>
                      <td>
                        <span className={owner.owner_id ? 'crm-strong' : 'crm-muted'}>
                          {owner.name}
                        </span>
                      </td>
                      <td className="crm-num">{owner.total}</td>
                      <td className="crm-num">{owner.converted}</td>
                      <td className="crm-num">
                        {owner.pending_follow_ups > 0 ? owner.pending_follow_ups : '—'}
                      </td>
                      <td className="crm-num">{owner.conversion_rate}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </CrmPage>
  )
}

/* --------------------------------------------------------------- the chart --- */

/** Two series over the same days: leads in, and leads won.
 *
 * Written here rather than reusing `components/charts` because none of those
 * take two series, and the comparison *is* the chart — a second panel showing
 * conversions separately would make the reader hold two shapes in their head to
 * answer one question.
 *
 * Both series are drawn as lines with a soft fill under the first. Every day in
 * the range is a point, including the empty ones: a chart that skips quiet days
 * draws a busy week and a quiet week identically. */
function TrendChart({ points }: { points: TrendPoint[] }) {
  const [hover, setHover] = useState<number | null>(null)

  const geometry = useMemo(() => {
    const W = 960
    const H = 220
    const padL = 34
    const padR = 12
    const padT = 12
    const padB = 28
    const plotW = W - padL - padR
    const plotH = H - padT - padB
    const peak = Math.max(...points.map((p) => Math.max(p.new_leads, p.converted)), 0)
    const max = peak > 0 ? peak : 1
    const step = points.length > 1 ? plotW / (points.length - 1) : plotW
    const x = (index: number) => padL + index * step
    const y = (value: number) => padT + plotH - (value / max) * plotH
    return { W, H, padL, padR, padT, padB, plotW, plotH, max, step, x, y }
  }, [points])

  if (points.length === 0) return <p className="empty">No leads in this range.</p>

  const { W, H, padL, padT, padB, plotW, plotH, max, x, y } = geometry
  const line = (pick: (p: TrendPoint) => number) =>
    points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(index)} ${y(pick(point))}`).join(' ')
  const area = `${line((p) => p.new_leads)} L ${x(points.length - 1)} ${padT + plotH} L ${padL} ${
    padT + plotH
  } Z`

  // At most a dozen labels: a 365-day range would otherwise print a wall of
  // dates on top of each other.
  const labelEvery = Math.max(1, Math.ceil(points.length / 12))

  return (
    <div style={{ position: 'relative' }}>
      <svg
        className="chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="New and converted leads per day"
        onMouseLeave={() => setHover(null)}
      >
        {/* Deduplicated: on a quiet range the midpoint rounds to the same
            integer as the top, and the axis read "1 / 1 / 0". */}
        {[...new Set([0, Math.round(max / 2), max])].map((value) => (
          <g key={value}>
            <line
              className="gridline"
              x1={padL}
              x2={W - 12}
              y1={y(value)}
              y2={y(value)}
            />
            <text className="axis-label" x={padL - 6} y={y(value) + 3} textAnchor="end">
              {Math.round(value)}
            </text>
          </g>
        ))}

        <path d={area} fill="var(--series-1)" opacity={0.14} />
        <path d={line((p) => p.new_leads)} fill="none" stroke="var(--series-1)" strokeWidth={2} />
        <path
          d={line((p) => p.converted)}
          fill="none"
          stroke="var(--status-good)"
          strokeWidth={2}
        />

        {points.map((point, index) => (
          <g key={point.day}>
            {/* A full-height hit strip: a 2px line is not a target anybody can
                hit with a mouse. */}
            <rect
              x={x(index) - (plotW / points.length) / 2}
              y={padT}
              width={Math.max(4, plotW / points.length)}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHover(index)}
            />
            {hover === index && (
              <>
                <line
                  x1={x(index)}
                  x2={x(index)}
                  y1={padT}
                  y2={padT + plotH}
                  stroke="var(--border-strong)"
                  strokeDasharray="3 3"
                />
                <circle cx={x(index)} cy={y(point.new_leads)} r={3.5} fill="var(--series-1)" />
                <circle cx={x(index)} cy={y(point.converted)} r={3.5} fill="var(--status-good)" />
              </>
            )}
            {index % labelEvery === 0 && (
              <text
                className="axis-label"
                x={x(index)}
                y={H - padB + 18}
                textAnchor="middle"
              >
                {new Date(`${point.day}T00:00:00`).toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'short',
                })}
              </text>
            )}
          </g>
        ))}
      </svg>

      {hover !== null && (
        <div
          className="tooltip"
          style={{
            position: 'absolute',
            left: `${(x(hover) / W) * 100}%`,
            top: 0,
            transform: 'translate(-50%, -8px)',
            pointerEvents: 'none',
          }}
        >
          <div className="tooltip-title">
            {new Date(`${points[hover].day}T00:00:00`).toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'short',
            })}
          </div>
          <div className="tooltip-row">
            <span>New Leads</span>
            <strong>{points[hover].new_leads}</strong>
          </div>
          <div className="tooltip-row">
            <span>Converted</span>
            <strong>{points[hover].converted}</strong>
          </div>
        </div>
      )}
    </div>
  )
}
