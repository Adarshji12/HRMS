import { useId } from 'react'
import { useTooltip } from './Tooltip'
import { duration, PRODUCTIVITY_COLOR, PRODUCTIVITY_LABEL, shortDate, weekday } from '../lib/format'
import type { Breakdown, HourBucket, DailyPoint, Segment } from '../lib/types'

/** Bar with only its data-end rounded — the baseline end stays square. */
function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  const radius = Math.max(0, Math.min(r, w / 2, h))
  return [
    `M${x},${y + h}`,
    `L${x},${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `L${x + w - radius},${y}`,
    `Q${x + w},${y} ${x + w},${y + radius}`,
    `L${x + w},${y + h}`,
    'Z',
  ].join(' ')
}

/* ------------------------------------------------------------------ hourly -- */

const HOURLY_LEGEND = [
  { label: 'Productive', color: PRODUCTIVITY_COLOR.productive },
  { label: 'Neutral', color: PRODUCTIVITY_COLOR.neutral },
  { label: 'Unproductive', color: PRODUCTIVITY_COLOR.unproductive },
]

export { HOURLY_LEGEND }

export function HourlyChart({ data }: { data: HourBucket[] }) {
  const tooltip = useTooltip()
  const clipId = useId()

  const W = 720
  const H = 190
  const padL = 34
  const padR = 6
  const padT = 8
  const padB = 22
  const plotW = W - padL - padR
  const plotH = H - padT - padB

  const totals = data.map((d) => d.productive_s + d.unproductive_s + Math.max(0, neutralOf(d)))
  const max = Math.max(600, ...totals)
  const slot = plotW / 24
  const barW = Math.max(6, slot - 6)

  const ticks = [0, max / 2, max]

  return (
    <svg
      className="chart-svg"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Activity by hour of day, split by productivity"
    >
      <clipPath id={clipId}>
        <rect x={padL} y={padT} width={plotW} height={plotH} />
      </clipPath>

      {ticks.map((value) => {
        const y = padT + plotH - (value / max) * plotH
        return (
          <g key={value}>
            <line className="gridline" x1={padL} x2={W - padR} y1={y} y2={y} />
            <text className="axis-label" x={padL - 7} y={y + 3} textAnchor="end">
              {value === 0 ? '0' : `${Math.round(value / 60)}m`}
            </text>
          </g>
        )
      })}

      <g clipPath={`url(#${clipId})`}>
        {data.map((bucket) => {
          const neutral = Math.max(0, neutralOf(bucket))
          const total = bucket.productive_s + bucket.unproductive_s + neutral
          const x = padL + bucket.hour * slot + (slot - barW) / 2
          if (total <= 0) return null

          const parts: Array<[number, string]> = [
            [bucket.productive_s, PRODUCTIVITY_COLOR.productive],
            [neutral, PRODUCTIVITY_COLOR.neutral],
            [bucket.unproductive_s, PRODUCTIVITY_COLOR.unproductive],
          ]
          const segments = parts.filter(([value]) => value > 0)

          let cursorY = padT + plotH
          const rects = segments.map(([value, color], index) => {
            const h = (value / max) * plotH
            const y = cursorY - h
            // 2px surface gap between stacked fills — not a border.
            const gap = index === segments.length - 1 ? 0 : 2
            cursorY = y - gap
            const isTop = index === segments.length - 1
            return isTop ? (
              <path key={color} d={barPath(x, y, barW, Math.max(1, h))} fill={color} />
            ) : (
              <rect key={color} x={x} y={y} width={barW} height={Math.max(1, h)} fill={color} />
            )
          })

          return (
            <g
              key={bucket.hour}
              onMouseMove={(event) =>
                tooltip.show(event, {
                  title: `${String(bucket.hour).padStart(2, '0')}:00 – ${String(
                    (bucket.hour + 1) % 24,
                  ).padStart(2, '0')}:00`,
                  rows: [
                    ['Productive', duration(bucket.productive_s)],
                    ['Neutral', duration(neutral)],
                    ['Unproductive', duration(bucket.unproductive_s)],
                    ['Active', duration(bucket.active_s)],
                  ],
                })
              }
              onMouseLeave={tooltip.hide}
            >
              {/* Hit target spans the whole slot, not just the bar. */}
              <rect
                x={padL + bucket.hour * slot}
                y={padT}
                width={slot}
                height={plotH}
                fill="transparent"
              />
              {rects}
            </g>
          )
        })}
      </g>

      <line className="baseline" x1={padL} x2={W - padR} y1={padT + plotH} y2={padT + plotH} />
      {[0, 6, 12, 18, 23].map((hour) => (
        <text
          key={hour}
          className="axis-label"
          x={padL + hour * slot + slot / 2}
          y={H - 6}
          textAnchor="middle"
        >
          {String(hour).padStart(2, '0')}
        </text>
      ))}
    </svg>
  )
}

function neutralOf(bucket: HourBucket): number {
  // The API sends productive/unproductive explicitly; whatever active time is
  // left over in the hour is neutral.
  return bucket.active_s - bucket.productive_s - bucket.unproductive_s
}

/* ------------------------------------------------------------- ranked bars -- */

export function RankedBars({
  items,
  max: explicitMax,
  emptyLabel = 'No activity recorded',
}: {
  items: Breakdown[]
  max?: number
  emptyLabel?: string
}) {
  const tooltip = useTooltip()
  if (items.length === 0) return <p className="empty">{emptyLabel}</p>

  const max = explicitMax ?? Math.max(...items.map((item) => item.duration_s), 1)

  return (
    <div>
      {items.map((item) => (
        <div
          className="hbar-row"
          key={item.label}
          onMouseMove={(event) =>
            tooltip.show(event, {
              title: item.label,
              rows: [
                ['Total', duration(item.duration_s)],
                ['Active', duration(item.active_s)],
                ['Class', PRODUCTIVITY_LABEL[item.productivity]],
              ],
            })
          }
          onMouseLeave={tooltip.hide}
        >
          <span className="hbar-label" title={item.label}>
            {item.label}
          </span>
          {/* Direct label: the relief rule requires a visible value, not a
              tooltip-only one. */}
          <span className="hbar-value">{duration(item.duration_s)}</span>
          <span className="hbar-track">
            <span
              className="hbar-fill"
              style={{
                width: `${Math.max(1.5, (item.duration_s / max) * 100)}%`,
                background: PRODUCTIVITY_COLOR[item.productivity],
              }}
            />
          </span>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------- daily series -- */

export function DailyBars({ data }: { data: DailyPoint[] }) {
  const tooltip = useTooltip()
  if (data.length === 0) return <p className="empty">No data in this range</p>

  const W = 720
  const H = 200
  const padL = 38
  const padR = 6
  const padT = 8
  const padB = 34
  const plotW = W - padL - padR
  const plotH = H - padT - padB

  const max = Math.max(3600, ...data.map((d) => d.tracked_s))
  const slot = plotW / data.length
  const barW = Math.max(8, Math.min(46, slot - 12))

  return (
    <svg
      className="chart-svg"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Tracked time per day, split by productivity"
    >
      {[0, max / 2, max].map((value) => {
        const y = padT + plotH - (value / max) * plotH
        return (
          <g key={value}>
            <line className="gridline" x1={padL} x2={W - padR} y1={y} y2={y} />
            <text className="axis-label" x={padL - 7} y={y + 3} textAnchor="end">
              {(value / 3600).toFixed(0)}h
            </text>
          </g>
        )
      })}

      {data.map((point, index) => {
        const x = padL + index * slot + (slot - barW) / 2
        const parts: Array<[number, string]> = [
          [point.productive_s, PRODUCTIVITY_COLOR.productive],
          [point.neutral_s, PRODUCTIVITY_COLOR.neutral],
          [point.unproductive_s, PRODUCTIVITY_COLOR.unproductive],
        ]
        const segments = parts.filter(([value]) => value > 0)

        let cursorY = padT + plotH
        const rects = segments.map(([value, color], segIndex) => {
          const h = (value / max) * plotH
          const y = cursorY - h
          cursorY = y - (segIndex === segments.length - 1 ? 0 : 2)
          const isTop = segIndex === segments.length - 1
          return isTop ? (
            <path key={color} d={barPath(x, y, barW, Math.max(1, h))} fill={color} />
          ) : (
            <rect key={color} x={x} y={y} width={barW} height={Math.max(1, h)} fill={color} />
          )
        })

        return (
          <g
            key={point.date}
            onMouseMove={(event) =>
              tooltip.show(event, {
                title: shortDate(point.date),
                rows: [
                  ['Tracked', duration(point.tracked_s)],
                  ['Active', duration(point.active_s)],
                  ['Productive', duration(point.productive_s)],
                  ['Unproductive', duration(point.unproductive_s)],
                  ['Productivity', `${point.productivity_pct}%`],
                ],
              })
            }
            onMouseLeave={tooltip.hide}
          >
            <rect x={padL + index * slot} y={padT} width={slot} height={plotH} fill="transparent" />
            {rects}
            <text
              className="axis-label"
              x={padL + index * slot + slot / 2}
              y={H - 18}
              textAnchor="middle"
            >
              {weekday(point.date)}
            </text>
            <text
              className="axis-label"
              x={padL + index * slot + slot / 2}
              y={H - 6}
              textAnchor="middle"
            >
              {shortDate(point.date)}
            </text>
          </g>
        )
      })}

      <line className="baseline" x1={padL} x2={W - padR} y1={padT + plotH} y2={padT + plotH} />
    </svg>
  )
}

/* ---------------------------------------------------------------- timeline -- */

export function TimelineStrip({
  segments,
  dayStartHour = 0,
  dayEndHour = 24,
}: {
  segments: Segment[]
  dayStartHour?: number
  dayEndHour?: number
}) {
  const tooltip = useTooltip()
  if (segments.length === 0) return <p className="empty">No activity recorded on this day</p>

  const first = new Date(segments[0].started_at)
  const dayStart = new Date(first)
  dayStart.setHours(dayStartHour, 0, 0, 0)
  const spanMs = (dayEndHour - dayStartHour) * 3600 * 1000

  return (
    <div>
      <div className="timeline">
        {segments.map((segment) => {
          const startMs = new Date(segment.started_at).getTime() - dayStart.getTime()
          const widthMs = new Date(segment.ended_at).getTime() - new Date(segment.started_at).getTime()
          const left = (startMs / spanMs) * 100
          const width = (widthMs / spanMs) * 100
          if (left < -5 || left > 105) return null

          return (
            <span
              key={segment.id}
              className="timeline-seg"
              style={{
                left: `${Math.max(0, left)}%`,
                width: `${Math.max(0.25, width)}%`,
                background: segment.is_idle
                  ? 'var(--gridline)'
                  : PRODUCTIVITY_COLOR[segment.productivity],
                opacity: segment.is_idle ? 1 : 0.92,
              }}
              onMouseMove={(event) =>
                tooltip.show(event, {
                  title: segment.app_name || 'Unknown',
                  rows: [
                    [
                      'Window',
                      new Date(segment.started_at).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                      }),
                    ],
                    ['Duration', duration(segment.duration_s)],
                    ['Active', duration(segment.active_s)],
                    ['Idle', duration(segment.idle_s)],
                    ...(segment.url_domain
                      ? ([['Site', segment.url_domain]] as Array<[string, string]>)
                      : []),
                    ['Class', segment.is_idle ? 'Idle' : PRODUCTIVITY_LABEL[segment.productivity]],
                  ],
                })
              }
              onMouseLeave={tooltip.hide}
            />
          )
        })}
      </div>
      <div className="timeline-axis">
        {Array.from({ length: 5 }, (_, i) => dayStartHour + ((dayEndHour - dayStartHour) / 4) * i).map(
          (hour) => (
            <span key={hour}>{String(Math.round(hour) % 24).padStart(2, '0')}:00</span>
          ),
        )}
      </div>
    </div>
  )
}
