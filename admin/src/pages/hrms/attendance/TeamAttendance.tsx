import { useMemo, useState } from 'react'
import '../../../styles/attendance.css'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { canViewTeam, useAuth } from '../../../lib/auth'
import { clockTime } from '../../../lib/format'
import { Empty, EmptyState, ErrorNote, Identity, Loading, StatTile } from '../../../components/ui'
import {
  addDays,
  DayDetail,
  DayFlags,
  hm,
  longDate,
  orgToday,
  STATUS,
  StatusPill,
  type AttendanceDay,
  type AttendanceStatus,
} from './MyAttendance'
import {
  canApproveRegularization,
  DayRegularization,
  RegularizationQueue,
  type RegRequest,
} from './regularization'

/** How far back the per-person drill-down reaches. */
const DETAIL_DAYS = 30

type Panel = 'muster' | 'corrections'

export default function TeamAttendance() {
  const { user, organization } = useAuth()
  const tz = organization?.timezone
  const today = orgToday(tz)
  const [day, setDay] = useState(today)
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [subject, setSubject] = useState<{ id: string; name: string } | null>(null)
  const [panel, setPanel] = useState<Panel>('muster')

  /* `can_approve_regularization` restricts rather than grants, so absent means
     not-restricted. The server gates the queue on this flag *and* on the team
     role — D-002 kept it separate from `can_approve_leave` because the lead who
     signs off "you were in the office at 09:15" is routinely not the person who
     signs off "you may take nine days off". Only one of those spends a balance,
     and only one rewrites the record payroll reads. */
  const mayDecide = canApproveRegularization(user)

  /* The rail and the route already hide this from an employee. Kept here so a
     bookmark lands on an explanation rather than an empty table: the endpoint
     is TeamViewer-only and would 403. */
  if (!canViewTeam(user)) {
    return (
      <EmptyState
        title="Team attendance is for managers"
        body="You can see your own punches and calendar on My attendance."
      />
    )
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Team attendance</h1>
          <p className="page-sub">
            The daily muster for everyone who reports to you.
          </p>
        </div>
      </div>

      {mayDecide && !subject && (
        <div className="ts-toggle" style={{ marginBottom: 14 }}>
          <button
            className={`ts-toggle-btn${panel === 'muster' ? ' ts-toggle-on' : ''}`}
            onClick={() => setPanel('muster')}
          >
            Muster
          </button>
          <button
            className={`ts-toggle-btn${panel === 'corrections' ? ' ts-toggle-on' : ''}`}
            onClick={() => setPanel('corrections')}
          >
            Corrections
          </button>
        </div>
      )}

      {mayDecide && panel === 'corrections' && !subject ? (
        <RegularizationQueue timeZone={tz} />
      ) : subject ? (
        <PersonHistory
          userId={subject.id}
          name={subject.name}
          end={day}
          timezone={tz}
          mayFileOnBehalf={mayDecide}
          onBack={() => setSubject(null)}
        />
      ) : (
        <>
          <div className="filter-row">
            <div className="att-cal-nav">
              <button className="btn btn-sm" onClick={() => setDay(addDays(day, -1))} aria-label="Previous day">
                ←
              </button>
              <input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Day" />
              <button className="btn btn-sm" onClick={() => setDay(addDays(day, 1))} aria-label="Next day">
                →
              </button>
              <button className="btn btn-sm" onClick={() => setDay(today)} disabled={day === today}>
                Today
              </button>
            </div>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name…"
              aria-label="Search people"
              style={{ minWidth: 200 }}
            />
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              <option value="">All statuses</option>
              {(Object.keys(STATUS) as AttendanceStatus[]).map((key) => (
                <option key={key} value={key}>
                  {STATUS[key].label}
                </option>
              ))}
            </select>
          </div>

          <Muster
            day={day}
            today={today}
            status={status}
            q={q}
            timezone={tz}
            onOpen={(id, name) => setSubject({ id, name })}
          />
        </>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- muster -- */

function Muster({
  day,
  today,
  status,
  q,
  timezone,
  onOpen,
}: {
  day: string
  today: string
  status: string
  q: string
  timezone: string | undefined
  onOpen: (userId: string, name: string) => void
}) {
  const { data, error, loading, refetching } = useQuery<AttendanceDay[]>(`att-team:${day}`, () =>
    api.get<AttendanceDay[]>(`/attendance/team?start=${day}&end=${day}`),
  )

  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    let late = 0
    let missing = 0
    let worked = 0
    for (const row of data ?? []) {
      out[row.status] = (out[row.status] ?? 0) + 1
      if (row.is_late) late += 1
      if (row.is_missing_punch) missing += 1
      worked += row.worked_minutes
    }
    return { out, late, missing, worked }
  }, [data])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (data ?? [])
      .filter((row) => (status ? row.status === status : true))
      .filter((row) => (needle ? (row.user_name ?? '').toLowerCase().includes(needle) : true))
      .sort((a, b) => (a.user_name ?? '').localeCompare(b.user_name ?? ''))
  }, [data, status, q])

  if (error) return <ErrorNote>{error}</ErrorNote>
  if (loading && !data) return <Loading />
  if (!data) return null

  return (
    <div className={refetching ? 'refetching' : undefined}>
      <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
        <StatTile label="Records" value={String(data.length)} meta={longDate(day)} />
        <StatTile label="Present" value={String(counts.out.present ?? 0)} accent="var(--status-good)" />
        <StatTile
          label="Absent"
          value={String(counts.out.absent ?? 0)}
          accent={counts.out.absent ? 'var(--status-critical)' : undefined}
        />
        <StatTile label="Half day / leave" value={`${counts.out.half_day ?? 0} / ${counts.out.on_leave ?? 0}`} />
        <StatTile
          label="Late"
          value={String(counts.late)}
          meta={counts.missing ? `${counts.missing} with no check-out` : 'all check-outs in'}
          accent={counts.late ? 'var(--status-warn)' : undefined}
        />
      </div>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Muster</h2>
          <span className="card-note">{hm(counts.worked)} worked across the team</span>
        </div>

        {/* Said plainly, because the alternative is a manager concluding that
            somebody was deleted. `history` returns stored rows only — the
            nightly job writes absent / weekly-off / holiday rows after the day
            ends, so a day still in progress lists only people who have punched
            or who already have a row. */}
        <p className="setting-hint" style={{ marginTop: -6, marginBottom: 12 }}>
          {day >= today
            ? 'Today is still running. Only people who already have a record for it appear here — absences and weekly offs are written after the day ends.'
            : 'One row per person with a record on this date.'}
        </p>

        {data.length === 0 ? (
          <EmptyState
            title="No attendance for this day"
            body={
              day >= today
                ? 'Nobody in your team has punched yet today, and the nightly job has not classified the day.'
                : 'Nobody in your reporting line has a record on this date. If that is wrong, an administrator can re-run the classification for the range from Attendance settings.'
            }
          />
        ) : rows.length === 0 ? (
          <Empty>No one matches that filter.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Shift</th>
                  <th>In</th>
                  <th>Out</th>
                  <th className="num">Worked</th>
                  <th>Status</th>
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.user_id ?? row.date}>
                    <td>
                      <Identity
                        name={row.user_name ?? 'Unnamed'}
                        small
                        meta={
                          row.user_id ? (
                            <button
                              className="link-btn"
                              onClick={() => onOpen(row.user_id!, row.user_name ?? 'Employee')}
                            >
                              Last {DETAIL_DAYS} days
                            </button>
                          ) : null
                        }
                      />
                    </td>
                    <td className="muted-sm">
                      {row.shift_name ? (
                        <>
                          {row.shift_name}
                          <div className="muted-sm">
                            {row.shift_start_time} – {row.shift_end_time}
                          </div>
                        </>
                      ) : (
                        'Unassigned'
                      )}
                    </td>
                    <td>{clockTime(row.check_in_at, timezone)}</td>
                    <td>{clockTime(row.check_out_at, timezone)}</td>
                    <td className="num">
                      <b>{hm(row.worked_minutes)}</b>
                    </td>
                    <td>
                      <StatusPill status={row.status} />
                    </td>
                    <td>
                      <DayFlags day={row} />
                    </td>
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

/* -------------------------------------------------------- person history -- */

function PersonHistory({
  userId,
  name,
  end,
  timezone,
  mayFileOnBehalf,
  onBack,
}: {
  userId: string
  name: string
  end: string
  timezone: string | undefined
  /** D-008: filing for somebody who has no laptop is a real requirement, and it
      is a *separate*, permission-gated endpoint with the subject in the path —
      never an optional `user_id` on the ordinary submit body. */
  mayFileOnBehalf: boolean
  onBack: () => void
}) {
  const { user } = useAuth()
  const start = addDays(end, -(DETAIL_DAYS - 1))
  const [open, setOpen] = useState<string | null>(null)
  const { data, error, loading, refetching, reload } = useQuery<AttendanceDay[]>(
    `att-team-person:${userId}:${end}`,
    () =>
      api.get<AttendanceDay[]>(
        `/attendance/team?user_id=${userId}&start=${start}&end=${end}`,
      ),
  )

  /* Same endpoint as the employee's own history, with the subject named. The
     hierarchy service scopes it exactly as it scopes the review queue: an
     employee passing somebody else's id gets a 403, not a filtered empty list,
     so there is nothing here that could quietly widen. */
  const regQ = useQuery<RegRequest[]>(`att-team-person-reg:${userId}`, () =>
    api.get<RegRequest[]>(`/regularization?user_id=${userId}`),
  )

  const openDay = open ? (data ?? []).find((row) => row.date === open) ?? null : null

  const totals = useMemo(() => {
    let worked = 0
    let late = 0
    let lateMinutes = 0
    let missing = 0
    let present = 0
    for (const row of data ?? []) {
      worked += row.worked_minutes
      if (row.is_late) {
        late += 1
        lateMinutes += row.late_minutes
      }
      if (row.is_missing_punch) missing += 1
      if (row.status === 'present') present += 1
    }
    return { worked, late, lateMinutes, missing, present }
  }, [data])

  return (
    <div>
      <button className="ts-back" onClick={onBack}>
        ← Back to the muster
      </button>

      <div className="page-head" style={{ marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 650 }}>{name}</h2>
          <p className="page-sub">
            {start} → {end} · stored records only
          </p>
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Loading />}

      {data && (
        <div className={refetching ? 'refetching' : undefined}>
          <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
            <StatTile label="Present" value={String(totals.present)} accent="var(--status-good)" />
            <StatTile label="Worked" value={hm(totals.worked)} />
            <StatTile
              label="Late"
              value={String(totals.late)}
              meta={totals.late ? `${hm(totals.lateMinutes)} in total` : 'never late'}
              accent={totals.late ? 'var(--status-warn)' : undefined}
            />
            <StatTile
              label="Missing check-out"
              value={String(totals.missing)}
              accent={totals.missing ? 'var(--status-critical)' : undefined}
            />
          </div>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Last {DETAIL_DAYS} days</h2>
            </div>
            {data.length === 0 ? (
              <EmptyState
                title="No records in this window"
                body="Either this person has not punched in the last thirty days, or they have moved out of your reporting line."
              />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Shift</th>
                      <th>In</th>
                      <th>Out</th>
                      <th className="num">Worked</th>
                      <th>Status</th>
                      <th>Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data].reverse().map((row) => (
                      <tr key={row.date}>
                        <td>
                          <button
                            className="link-btn"
                            onClick={() => setOpen(open === row.date ? null : row.date)}
                          >
                            {longDate(row.date)}
                          </button>
                        </td>
                        <td className="muted-sm">{row.shift_name ?? 'Unassigned'}</td>
                        <td>{clockTime(row.check_in_at, timezone)}</td>
                        <td>{clockTime(row.check_out_at, timezone)}</td>
                        <td className="num">
                          <b>{hm(row.worked_minutes)}</b>
                        </td>
                        <td>
                          <StatusPill status={row.status} />
                        </td>
                        <td>
                          <DayFlags day={row} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {open && (
              <>
                {regQ.error && <ErrorNote>{regQ.error}</ErrorNote>}
                {openDay ? (
                  <DayDetail day={openDay} timezone={timezone} onClose={() => setOpen(null)}>
                    <DayRegularization
                      key={open}
                      date={open}
                      day={openDay}
                      timeZone={timezone}
                      requests={regQ.data}
                      onFiled={() => {
                        regQ.reload()
                        reload()
                      }}
                      canFile={mayFileOnBehalf}
                      /* Filing about yourself goes through the ordinary
                         endpoint even when you hold the flag: the on-behalf
                         path exists to record that somebody else asked, and
                         routing a self-filed request through it would make the
                         audit row say so falsely. */
                      onBehalf={userId === user?.id ? null : { userId, name }}
                    />
                  </DayDetail>
                ) : null}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
