import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import '../../../styles/workforce.css'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { useAuth } from '../../../lib/auth'
import { Avatar, EmptyState, ErrorNote, Loading } from '../../../components/ui'
import { Donut, ColumnChart, type Column, type Slice } from '../../../components/charts'
import { IconBell, IconClock, IconReturn } from '../../../components/Icons'

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

/* The four categorical slots, in their declared order, then a neutral for
   everything folded into "Other". Assigned by rank within a month and never
   cycled — see the note at the top of the file. */
const SLOT_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)']
const OTHER_COLOR = 'var(--neutral-mark)'
const MAX_SLICES = 4

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

  /* The ring, built from the month's tallies: the four largest keep their own
     slot colour and the rest become one "Other" arc. Types with nothing in them
     never reach the ring at all — a zero-width arc is not a slice, it is an
     invisible legend entry. */
  const { slices, totalMilli } = useMemo(() => {
    const used = (q.data?.by_type ?? []).filter((row) => row.milli_days > 0)
    const head = used.slice(0, MAX_SLICES)
    const tail = used.slice(MAX_SLICES)
    const built: Slice[] = head.map((row, index) => ({
      key: row.leave_type_id,
      label: row.name,
      value: row.milli_days,
      color: SLOT_COLORS[index],
    }))
    if (tail.length > 0) {
      built.push({
        key: 'other',
        label: `${tail.length} other ${tail.length === 1 ? 'type' : 'types'}`,
        value: tail.reduce((n, row) => n + row.milli_days, 0),
        color: OTHER_COLOR,
      })
    }
    return {
      slices: built,
      totalMilli: used.reduce((n, row) => n + row.milli_days, 0),
    }
  }, [q.data])

  /* Which colour a legend row wears. A type inside the ring wears its own slot;
     everything folded away wears the "Other" colour, so the legend and the ring
     agree about what the reader is looking at. */
  const colorFor = useMemo(() => {
    const map = new Map<string, string>()
    slices.forEach((slice) => map.set(slice.key, slice.color))
    return (row: TypeTally) =>
      row.milli_days > 0 ? map.get(row.leave_type_id) ?? OTHER_COLOR : 'var(--gridline)'
  }, [slices])

  const monthColumns: Column[] = (q.data?.by_month ?? []).map((row) => ({
    key: String(row.month),
    label: MONTHS[row.month - 1],
    title: `${MONTH_LONG[row.month - 1]} ${year}`,
    value: days(row.milli_days),
  }))

  const holidayColumns: Column[] = (q.data?.optional_holidays ?? []).map((row) => ({
    key: row.holiday_id,
    // Two words at most under an axis tick; the tooltip carries the whole name.
    label: row.name.split(/\s+/).slice(0, 2).join(' '),
    title: `${row.name} · ${row.holiday_date}`,
    value: row.employees,
  }))

  if (q.error) return <ErrorNote>{q.error}</ErrorNote>
  if (q.loading || !q.data) return <Loading label="Reading the year…" />
  const data = q.data

  return (
    <div className="page wf">
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

      {/* --------------------------------------------------- the month strip -- */}
      <section className="card wf-strip-card">
        <div className="wf-strip" role="tablist" aria-label="Month">
          {MONTHS.map((name, index) => {
            const value = data.by_month[index]?.milli_days ?? 0
            const on = month === index + 1
            return (
              <button
                key={name}
                role="tab"
                aria-selected={on}
                className={`wf-month${on ? ' is-on' : ''}`}
                onClick={() => setMonth(index + 1)}
              >
                <span className="wf-month-name">{name}</span>
                <span className="wf-month-year">{year}</span>
                {/* The month's own total, so the strip is a chart as well as a
                    control — you can see where the year's leave went before
                    opening any of it. */}
                <span className={`wf-month-value${value > 0 ? '' : ' is-none'}`}>
                  {value > 0 ? days(value) : '—'}
                </span>
              </button>
            )
          })}
        </div>
      </section>

      {/* ------------------------------------------------- type of leave taken -- */}
      <section className="card wf-types">
        <div className="card-head">
          <h2 className="card-title">
            <IconReturn size={15} /> Type of leave taken · {MONTH_LONG[month - 1]} {year}
          </h2>
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
          <div className="wf-types-body">
            <Donut
              slices={slices}
              total={days(totalMilli)}
              caption={days(totalMilli) === 1 ? 'day taken' : 'days taken'}
              unit="days"
            />

            {/* The legend, and the table view. Every type the company has, with
                its number — including the ones at zero, because "no sick leave
                this month" is a reading somebody came here for. */}
            <ul className="wf-legend">
              {data.by_type.map((row) => (
                <li key={row.leave_type_id} className={row.milli_days > 0 ? '' : 'is-zero'}>
                  <span className="wf-swatch" style={{ background: colorFor(row) }} aria-hidden="true" />
                  <span className="wf-legend-name" title={row.name}>
                    {row.code ?? row.name}
                  </span>
                  <span className="wf-legend-value">{days(row.milli_days)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------ charts -- */}
      <div className="wf-charts">
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">
              <IconClock size={15} /> Leave taken through {year}
            </h2>
            <span className="card-note">days</span>
          </div>
          <ColumnChart
            data={monthColumns}
            axisLabel={`Days of leave taken in each month of ${year}`}
            emptyLabel="No approved leave this year."
          />
        </section>

        <section className="card">
          <div className="card-head">
            <h2 className="card-title">
              <IconBell size={15} /> People on each optional holiday
            </h2>
            <span className="card-note">people</span>
          </div>
          {holidayColumns.length === 0 ? (
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
            <ColumnChart
              data={holidayColumns}
              axisLabel="How many people opted into each optional holiday"
            />
          )}
        </section>
      </div>

      {/* ------------------------------------------------------ who is away -- */}
      <section className="card wf-away">
        <div className="card-head">
          <h2 className="card-title">Away</h2>
          <div className="card-tools">
            <span className="card-note">
              {data.window_start} to {data.window_end}
            </span>
            <div className="wf-windows" role="group" aria-label="Period">
              {WINDOWS.map((option) => (
                <button
                  key={option.id}
                  className={`wf-window${window === option.id ? ' is-on' : ''}`}
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
          <EmptyState
            icon={<IconClock size={20} />}
            title="Nobody is away"
            body="Everyone you can see is expected in for this period."
          />
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
