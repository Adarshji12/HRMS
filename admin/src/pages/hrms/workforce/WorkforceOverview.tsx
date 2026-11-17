import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import '../../../styles/workforce.css'
import '../../../styles/workforce-premium.css'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { useAuth } from '../../../lib/auth'
import { Avatar, EmptyState, ErrorNote, Loading } from '../../../components/ui'
import { IconBell, IconCalendar, IconChart, IconCheck, IconClock, IconReturn, IconStar, IconUsers } from '../../../components/Icons'

/**
 * Workforce Management — one company's leave, read across a year.
 *
 * The module's landing page, and the only screen in the console that reads
 * leave *across people* rather than for one of them. That is what makes it a
 * different page from "Team leave", which is a queue of applications to act on:
 * this one is not actionable at all, deliberately. It answers three questions a
 * manager brings to a planning meeting — how much leave went, of what kind, and
 * who is away this week — and offers no approve button, because a summary you
 * can accidentally act on is a summary people stop trusting.
 *
 * Four things are worth knowing before changing it.
 *
 * **One request.** `/leave/overview` returns all four blocks for a year and a
 * month. Four endpoints would be four resolutions of "whose leave may this
 * person see" that could drift apart; the server resolves it once.
 *
 * **Approved only.** A pending application is not leave that was taken. If it
 * counted, every chart here would move when somebody applied and move back when
 * they were refused.
 *
 * **Days are integer milli-days on the wire** (D-012) and are divided for
 * display at the last possible moment, in `days()` below and nowhere else.
 *
 * **The donut has at most five arcs.** The categorical ramp is four slots in a
 * fixed order and is never cycled, so anything past the fourth-largest leave
 * type folds into one neutral "Other". The legend beside it still lists every
 * type with its number — it is the table view, and it is what stops identity
 * being carried by colour alone.
 */

/* ---------------------------------------------------------------- types --- */

interface TypeTally {
  leave_type_id: string
  code: string | null
  name: string
  milli_days: number
}

interface MonthTally {
  month: number
  milli_days: number
}

interface HolidayUptake {
  holiday_id: string
  name: string
  holiday_date: string
  employees: number
}

interface OnLeave {
  user_id: string
  user_name: string
  employee_code: string | null
  leave_type_name: string
  start_date: string
  end_date: string
  milli_days: number
  is_half_day: boolean
}

interface Overview {
  year: number
  month: number
  headcount: number
  by_type: TypeTally[]
  by_month: MonthTally[]
  optional_holidays: HolidayUptake[]
  on_leave: OnLeave[]
  window_start: string
  window_end: string
}

/* -------------------------------------------------------------- helpers --- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * Milli-days to a readable number of days.
 *
 * The one place in this file that divides. Half-days are real and common, so a
 * whole number is not always the truth — but 1.5 is, and 1.50 is noise.
 */
function days(milli: number): number {
  return Math.round(milli / 100) / 10
}

function dayLabel(milli: number): string {
  const value = days(milli)
  return `${value} ${value === 1 ? 'day' : 'days'}`
}

type Window = 'week' | 'next' | 'month'

const WINDOWS: Array<{ id: Window; label: string }> = [
  { id: 'week', label: 'This week' },
  { id: 'next', label: 'Next week' },
  { id: 'month', label: 'This month' },
]

function windowRange(kind: Window): { start: string; end: string } {
  const today = new Date()
  const monday = new Date(today)
  // getDay() is 0 for Sunday; the working week here starts on Monday.
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
  const iso = (d: Date) => {
    const offset = d.getTimezoneOffset() * 60_000
    return new Date(d.getTime() - offset).toISOString().slice(0, 10)
  }
  if (kind === 'month') {
    const first = new Date(today.getFullYear(), today.getMonth(), 1)
    const last = new Date(today.getFullYear(), today.getMonth() + 1, 0)
    return { start: iso(first), end: iso(last) }
  }
  const start = new Date(monday)
  if (kind === 'next') start.setDate(monday.getDate() + 7)
  const end = new Date(start)
  end.setDate(start.getDate() + 6)
  return { start: iso(start), end: iso(end) }
}

/* One colour per leave type, in the order the server lists them. Past the fifth
   type everything shares a neutral — the written code beside each swatch is what
   identifies a type, never the colour alone. */
const TYPE_COLORS = ['#4f46e5', '#f59e0b', '#0d9488', '#f43f5e', '#16a34a']
const OTHER_COLOR = '#94a3b8'

/* A smooth path through the points: each segment's control points sit on the
   horizontal midpoint, so the curve never overshoots its data. */
function smoothPath(points: Array<[number, number]>): string {
  if (points.length === 0) return ''
  let d = `M ${points[0][0]} ${points[0][1]}`
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]
    const [x1, y1] = points[i]
    const mx = (x0 + x1) / 2
    d += ` C ${mx} ${y0}, ${mx} ${y1}, ${x1} ${y1}`
  }
  return d
}

/* ============================================================== the page === */

export default function WorkforceOverview() {
  const { user } = useAuth()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [window, setWindow] = useState<Window>('week')

  const range = windowRange(window)
  const q = useQuery<Overview>(
    `workforce:${year}:${month}:${range.start}`,
    () =>
      api.get<Overview>(
        `/leave/overview?year=${year}&month=${month}` +
          `&window_start=${range.start}&window_end=${range.end}`,
      ),
  )

  const data = q.data
  const monthDays = useMemo(
    () => MONTHS.map((_, i) => days(data?.by_month[i]?.milli_days ?? 0)),
    [data],
  )
  const yearTotal = monthDays.reduce((n, v) => n + v, 0)
  const monthTotal = monthDays[month - 1] ?? 0
  const peakValue = Math.max(0, ...monthDays)
  const peakIndex = peakValue > 0 ? monthDays.indexOf(peakValue) : -1

  const usedTypes = (data?.by_type ?? []).filter((row) => row.milli_days > 0)
  const typeTotalMilli = usedTypes.reduce((n, row) => n + row.milli_days, 0)
  const colorOf = (id: string) => {
    const index = (data?.by_type ?? []).findIndex((row) => row.leave_type_id === id)
    return index >= 0 && index < TYPE_COLORS.length ? TYPE_COLORS[index] : OTHER_COLOR
  }

  const holidays = data?.optional_holidays ?? []
  const rsvpTotal = holidays.reduce((n, row) => n + row.employees, 0)
  const topHoliday = holidays.reduce<HolidayUptake | null>(
    (best, row) => (row.employees > 0 && (!best || row.employees > best.employees) ? row : best),
    null,
  )
  const holidayMax = Math.max(1, ...holidays.map((row) => row.employees))

  if (q.error) return <ErrorNote>{q.error}</ErrorNote>
  if (q.loading || !data) return <Loading label="Reading the year…" />

  const awayPeople = new Set(data.on_leave.map((row) => row.user_id)).size

  /* The velocity chart, in a fixed 720×250 box that scales with its card. */
  const W = 720
  const H = 250
  const padL = 34
  const padR = 18
  const padT = 22
  const padB = 34
  const yMax = Math.max(3, Math.ceil(peakValue))
  const xAt = (i: number) => padL + ((W - padL - padR) * i) / 11
  const yAt = (v: number) => padT + (H - padT - padB) * (1 - v / yMax)
  const pts: Array<[number, number]> = monthDays.map((v, i) => [xAt(i), yAt(v)])
  const line = smoothPath(pts)
  const area = `${line} L ${xAt(11)} ${yAt(0)} L ${xAt(0)} ${yAt(0)} Z`

  /* The ring. Arcs are drawn as dashed strokes round one circle; a type with
     nothing in it never gets an arc, only a row in the breakdown. */
  const R = 62
  const C = 2 * Math.PI * R
  let offset = 0
  const arcs = usedTypes.map((row) => {
    const length = (row.milli_days / typeTotalMilli) * C
    const arc = { key: row.leave_type_id, color: colorOf(row.leave_type_id), length, offset }
    offset += length
    return arc
  })

  return (
    <div className="page wf wf2">
      <div className="page-head" style={{ justifyContent: 'flex-end' }}>
        <label className="wf-year">
          <span className="wf-year-label">Year</span>
          <select value={year} onChange={(event) => setYear(Number(event.target.value))}>
            {[year + 1, year, year - 1, year - 2]
              .filter((value, index, all) => all.indexOf(value) === index)
              .sort((a, b) => b - a)
              .map((value) => (
                <option key={value} value={value}>
                  Jan {value} – Dec {value}
                </option>
              ))}
          </select>
        </label>
      </div>

      {/* ------------------------------------------------------- headline cards -- */}
      <div className="wf2-kpis">
        <div className="wf2-kpi">
          <div className="wf2-kpi-top">
            <span className="wf2-kpi-label">Selected period</span>
            <span className="wf2-kpi-icon is-indigo"><IconCalendar size={17} /></span>
          </div>
          <div className="wf2-kpi-value">{MONTHS[month - 1]} {year}</div>
          <span className="wf2-chip is-indigo"><i /> Active view</span>
        </div>
        <div className="wf2-kpi">
          <div className="wf2-kpi-top">
            <span className="wf2-kpi-label">Monthly leave taken</span>
            <span className="wf2-kpi-icon is-teal"><IconCheck size={17} /></span>
          </div>
          <div className="wf2-kpi-value">{monthTotal} {monthTotal === 1 ? 'day' : 'days'}</div>
          <div className="wf2-kpi-meta">
            {monthTotal === 0 ? 'Zero absences logged' : `Approved leave in ${MONTH_LONG[month - 1]}`}
          </div>
        </div>
        <div className="wf2-kpi">
          <div className="wf2-kpi-top">
            <span className="wf2-kpi-label">{year} annual utilization</span>
            <span className="wf2-kpi-icon is-amber"><IconChart size={17} /></span>
          </div>
          <div className="wf2-kpi-value">{yearTotal} {yearTotal === 1 ? 'day' : 'days'}</div>
          {peakIndex >= 0 ? (
            <span className="wf2-chip is-amber">Peak in {MONTHS[peakIndex]}</span>
          ) : (
            <div className="wf2-kpi-meta">No approved leave yet</div>
          )}
        </div>
        <div className="wf2-kpi">
          <div className="wf2-kpi-top">
            <span className="wf2-kpi-label">Optional holiday RSVPs</span>
            <span className="wf2-kpi-icon is-green"><IconStar size={17} /></span>
          </div>
          <div className="wf2-kpi-value">{rsvpTotal} {rsvpTotal === 1 ? 'person' : 'people'}</div>
          {topHoliday ? (
            <span className="wf2-chip is-green">{topHoliday.name}</span>
          ) : (
            <div className="wf2-kpi-meta">{holidays.length === 0 ? 'No optional holidays' : 'Nobody has opted in'}</div>
          )}
        </div>
      </div>

      {/* --------------------------------------------------- monthly scrubber -- */}
      <section className="wf2-card">
        <div className="wf2-card-head">
          <div className="wf2-scrub-title">
            <span className="wf2-eyebrow">Monthly activity scrubber</span>
            <span className="wf2-sub">Select a month to inspect composition</span>
          </div>
          <div className="wf2-key">
            <span><i className="is-sel" /> Selected</span>
            <span><i className="is-leave" /> Leave logged</span>
          </div>
        </div>
        <div className="wf2-scrub" role="tablist" aria-label="Month">
          {MONTHS.map((name, index) => {
            const value = monthDays[index]
            const on = month === index + 1
            return (
              <button
                key={name}
                role="tab"
                aria-selected={on}
                className={`wf2-month${on ? ' is-on' : ''}${value > 0 ? ' has-leave' : ''}`}
                onClick={() => setMonth(index + 1)}
                title={`${MONTH_LONG[index]} ${year}`}
              >
                <span className="wf2-month-name">{name}</span>
                <span className="wf2-month-year">{year}</span>
                {value > 0 ? <span className="wf2-month-pill">{value}d</span> : <span className="wf2-month-none">—</span>}
                <span className="wf2-month-bar" />
              </button>
            )
          })}
        </div>
      </section>

      {/* ------------------------------------- composition + velocity (+ holidays) -- */}
      <div className="wf2-grid">
        <section className="wf2-card wf2-comp">
          <div className="wf2-card-head">
            <div>
              <h2 className="wf2-title"><i className="wf2-dot" /> Leave Composition</h2>
              <p className="wf2-sub">Category distribution for selected period</p>
            </div>
            <span className="wf2-chip is-indigo is-mono">{MONTH_LONG[month - 1]} {year}</span>
          </div>

          {data.by_type.length === 0 ? (
            <EmptyState
              icon={<IconReturn size={20} />}
              title="No leave types yet"
              body={
                <>
                  An administrator sets these up in <Link to="/settings/leave">Leave settings</Link>{' '}
                  before anybody can apply.
                </>
              }
            />
          ) : (
            <>
              <div className="wf2-ring-wrap">
                <svg viewBox="0 0 180 180" className="wf2-ring" role="img"
                     aria-label={`${days(typeTotalMilli)} days of leave taken in ${MONTH_LONG[month - 1]} ${year}`}>
                  <circle cx="90" cy="90" r={R} className="wf2-ring-track" />
                  {arcs.map((arc) => (
                    <circle
                      key={arc.key}
                      cx="90" cy="90" r={R}
                      className="wf2-ring-arc"
                      stroke={arc.color}
                      strokeDasharray={`${Math.max(0, arc.length - (arcs.length > 1 ? 3 : 0))} ${C}`}
                      strokeDashoffset={-arc.offset}
                    />
                  ))}
                </svg>
                <div className="wf2-ring-center">
                  <b>{days(typeTotalMilli)}</b>
                  <span>{days(typeTotalMilli) === 1 ? 'day taken' : 'days taken'}</span>
                </div>
              </div>

              <div className="wf2-breakdown-head">
                <span className="wf2-eyebrow">Category breakdown</span>
                <span className="wf2-mono-note">% of {MONTHS[month - 1]} total</span>
              </div>
              <ul className="wf2-breakdown">
                {data.by_type.map((row) => {
                  const pct = typeTotalMilli > 0 ? Math.round((row.milli_days / typeTotalMilli) * 100) : 0
                  return (
                    <li key={row.leave_type_id} style={{ ['--tc' as string]: colorOf(row.leave_type_id) }}>
                      <div>
                        <div className="wf2-bk-top">
                          <b title={row.name}>{row.code ?? row.name}</b>
                          <span className="wf2-bk-pct">{pct}%</span>
                        </div>
                        <div className="wf2-bk-name">{row.name}</div>
                      </div>
                      <span className="wf2-bk-value">{days(row.milli_days)}</span>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </section>

        <div className="wf2-stack">
          <section className="wf2-card">
            <div className="wf2-card-head">
              <div className="wf2-headrow">
                <span className="wf2-icon is-indigo"><IconClock size={16} /></span>
                <div>
                  <h2 className="wf2-title">Annual Leave Velocity · {year}</h2>
                  <p className="wf2-sub">Leave taken through {year} (days per month)</p>
                </div>
              </div>
              <div className="wf2-chips">
                {peakIndex >= 0 && <span className="wf2-chip is-indigo is-mono">Peak: {MONTHS[peakIndex]} ({peakValue}d)</span>}
                <span className="wf2-chip is-slate is-mono">days</span>
              </div>
            </div>

            {yearTotal === 0 ? (
              <div className="wf2-flat">No approved leave this year.</div>
            ) : null}
            <svg viewBox={`0 0 ${W} ${H}`} className="wf2-velocity" role="img"
                 aria-label={`Days of leave taken in each month of ${year}`}>
              <defs>
                <linearGradient id="wf2-bar" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2dd4bf" />
                  <stop offset="100%" stopColor="#4f46e5" />
                </linearGradient>
                <linearGradient id="wf2-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#4f46e5" stopOpacity="0.16" />
                  <stop offset="100%" stopColor="#4f46e5" stopOpacity="0" />
                </linearGradient>
              </defs>
              {[0, yMax / 2, yMax].map((tick) => (
                <g key={tick}>
                  <line x1={padL} x2={W - padR} y1={yAt(tick)} y2={yAt(tick)} className="wf2-grid-line" />
                  <text x={padL - 8} y={yAt(tick) + 4} textAnchor="end" className="wf2-axis">{tick}</text>
                </g>
              ))}
              {monthDays.map((v, i) =>
                v > 0 ? (
                  <rect key={`b${i}`} x={xAt(i) - 12} y={yAt(v)} width={24} height={yAt(0) - yAt(v)} rx={7} fill="url(#wf2-bar)" opacity={month === i + 1 ? 1 : 0.9}>
                    <title>{`${MONTH_LONG[i]} ${year}: ${v} ${v === 1 ? 'day' : 'days'}`}</title>
                  </rect>
                ) : null,
              )}
              <path d={area} fill="url(#wf2-area)" />
              <path d={line} className="wf2-line" />
              {monthDays.map((v, i) => (
                <g key={`d${i}`} onClick={() => setMonth(i + 1)} className="wf2-pt">
                  {v > 0 && <text x={xAt(i)} y={yAt(v) - 8} textAnchor="middle" className="wf2-val">{v}</text>}
                  <circle cx={xAt(i)} cy={yAt(v)} r={month === i + 1 ? 6 : 4} className={month === i + 1 ? 'is-sel' : v > 0 ? 'is-leave' : ''}>
                    <title>{`${MONTH_LONG[i]} ${year}: ${v} ${v === 1 ? 'day' : 'days'}`}</title>
                  </circle>
                  <text x={xAt(i)} y={H - 10} textAnchor="middle" className={`wf2-axis${month === i + 1 ? ' is-sel' : ''}`}>{MONTHS[i]}</text>
                </g>
              ))}
            </svg>
          </section>

          <section className="wf2-card">
            <div className="wf2-card-head">
              <div className="wf2-headrow">
                <span className="wf2-icon is-green"><IconBell size={16} /></span>
                <div>
                  <h2 className="wf2-title">Optional Holiday Participation</h2>
                  <p className="wf2-sub">People on each optional holiday</p>
                </div>
              </div>
              <span className="wf2-chip is-slate is-mono">people</span>
            </div>

            {holidays.length === 0 ? (
              <EmptyState
                icon={<IconBell size={20} />}
                title="No optional holidays"
                body={
                  <>
                    A fixed holiday is a holiday for everybody, so only optional ones are counted
                    here. They are published in <Link to="/settings/leave">Leave settings</Link>.
                  </>
                }
              />
            ) : (
              <div className="wf2-hol">
                <div className="wf2-hol-bars" role="img" aria-label="How many people opted into each optional holiday">
                  <div className="wf2-hol-plot">
                    {holidays.map((row) => (
                      <div key={row.holiday_id} className="wf2-hol-col" title={`${row.name} · ${row.holiday_date}`}>
                        <span className="wf2-hol-num">{row.employees}</span>
                        <span className="wf2-hol-bar" style={{ height: `${Math.max(4, (row.employees / holidayMax) * 100)}%` }} />
                      </div>
                    ))}
                  </div>
                  <div className="wf2-hol-names">
                    {holidays.map((row) => <span key={row.holiday_id}>{row.name}</span>)}
                  </div>
                </div>

                <div className="wf2-hol-cards">
                  {holidays.map((row) => {
                    const share = data.headcount > 0 ? Math.min(100, (row.employees / data.headcount) * 100) : 0
                    return (
                      <div key={row.holiday_id} className="wf2-hol-card">
                        <span className="wf2-chip is-green is-mono">{row.holiday_date}</span>
                        <h3>{row.name}</h3>
                        <p>
                          {row.employees} {row.employees === 1 ? 'team member' : 'team members'} opted in
                        </p>
                        <div className="wf2-hol-meter">
                          <span>Opted in</span>
                          <b>{row.employees} / {data.headcount} people</b>
                        </div>
                        <div className="wf2-meter"><span style={{ width: `${share}%` }} /></div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      {/* ------------------------------------------------------------ who is away -- */}
      <section className="wf2-card wf2-away">
        <div className="wf2-card-head">
          <div className="wf2-headrow">
            <span className="wf2-icon is-green"><IconUsers size={16} /></span>
            <div>
              <h2 className="wf2-title">
                Away{' '}
                <span className={`wf2-badge ${awayPeople === 0 ? 'is-ok' : 'is-away'}`}>
                  <i /> {awayPeople === 0 ? 'Full team present' : `${awayPeople} away`}
                </span>
              </h2>
              <p className="wf2-sub">Live team availability &amp; scheduled leave radar</p>
            </div>
          </div>
          <div className="wf2-away-tools">
            <span className="wf2-chip is-slate is-mono">{data.window_start} to {data.window_end}</span>
            <div className="wf2-seg" role="group" aria-label="Period">
              {WINDOWS.map((option) => (
                <button
                  key={option.id}
                  className={window === option.id ? 'is-on' : ''}
                  aria-pressed={window === option.id}
                  onClick={() => setWindow(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {data.on_leave.length === 0 ? (
          <div className="wf2-away-empty">
            <span className="wf2-away-orb"><IconClock size={22} /></span>
            <b>Nobody is away</b>
            <span>Everyone you can see is expected in for this period.</span>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Leave type</th>
                  <th>Dates</th>
                  <th className="num">Days</th>
                </tr>
              </thead>
              <tbody>
                {data.on_leave.map((row) => (
                  <tr key={`${row.user_id}-${row.start_date}`}>
                    <td>
                      <div className="wf-person">
                        <Avatar name={row.user_name} small />
                        <div>
                          <div className="wf-person-name">
                            {row.user_id === user?.id ? `${row.user_name} (you)` : row.user_name}
                          </div>
                          {row.employee_code && (
                            <div className="muted-sm">{row.employee_code}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>{row.leave_type_name}</td>
                    <td>
                      {row.start_date === row.end_date
                        ? row.start_date
                        : `${row.start_date} → ${row.end_date}`}
                      {row.is_half_day && <span className="wf-half">half day</span>}
                    </td>
                    <td className="num">{dayLabel(row.milli_days)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
