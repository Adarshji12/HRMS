import { useEffect, useMemo, useState } from 'react'
import '../../../styles/meetings.css'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { useAuth } from '../../../lib/auth'
import { dateTime, relativeTime } from '../../../lib/format'
import { Avatar, EmptyState, ErrorNote, Loading } from '../../../components/ui'
import { IconCheck, IconClose, IconPlus, IconUsers } from '../../../components/Icons'

/**
 * Meetings — a time, a set of people, and a room.
 *
 * The video itself is rented. Media goes through a Jitsi deployment, and this
 * console never touches a stream: it schedules, it decides who may join, it
 * records who turned up, and it hands the room to a provider in an iframe. That
 * split is the whole design. Building an SFU is not an application problem, and
 * the half that earns its place in an HRMS — scheduling against a team,
 * inviting from the org chart, knowing who attended — is the half that is here.
 *
 * Two things about it are load-bearing.
 *
 * **The room name never reaches a URL.** On a public Jitsi deployment there is
 * no password and no lobby, so the name is the credential. It arrives from
 * `POST /meetings/{id}/join`, lives in component state for as long as the call
 * does, and goes nowhere else — not into the address bar, not into browser
 * history, not into a link anybody can paste.
 *
 * **An invitee list is a snapshot.** It is seeded from a team or the directory
 * when the meeting is booked and then frozen. That is the opposite of how chat
 * channels work, and it is right for the same reason chat's rule is right: a
 * channel is a place, a meeting is an event.
 */

/* ---------------------------------------------------------------- types --- */

interface Invitee {
  user_id: string
  user_name: string
  employee_code: string | null
  joined_at: string | null
}

interface Meeting {
  id: string
  title: string
  agenda: string | null
  starts_at: string
  duration_minutes: number
  status: 'scheduled' | 'cancelled'
  host_user_id: string | null
  host_name: string | null
  seeded_from: string | null
  invitee_count: number
  attended_count: number
  can_join: boolean
  can_cancel: boolean
  invitees?: Invitee[]
}

interface Room {
  domain: string
  room: string
  display_name: string
}

interface Team {
  id: string
  name: string
}

interface DirectoryEntry {
  user_id: string
  full_name: string
  designation: string | null
  department: string | null
}

/* ============================================================== the page === */

export default function Meetings() {
  const { user } = useAuth()
  const q = useQuery<Meeting[]>('meetings', () => api.get<Meeting[]>('/meetings'))
  const [room, setRoom] = useState<{ meeting: Meeting; room: Room } | null>(null)
  const [scheduling, setScheduling] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  async function join(meeting: Meeting) {
    setFailure(null)
    try {
      /* Re-asked every time rather than cached on the listing. `can_join` was
         true when the page loaded and a browser tab lives for hours; the server
         re-checks the window, the cancellation and the invitation, and this is
         also where attendance gets stamped. */
      setRoom({ meeting, room: await api.post<Room>(`/meetings/${meeting.id}/join`) })
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'That room could not be opened.')
      q.reload()
    }
  }

  async function cancel(meeting: Meeting) {
    setFailure(null)
    try {
      await api.post(`/meetings/${meeting.id}/cancel`)
      q.reload()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'That could not be cancelled.')
    }
  }

  if (room) {
    return (
      <RoomView
        meeting={room.meeting}
        room={room.room}
        onLeave={() => {
          setRoom(null)
          q.reload()
        }}
      />
    )
  }

  if (q.error) return <ErrorNote>{q.error}</ErrorNote>
  if (q.loading) return <Loading label="Reading your calendar…" />

  const meetings = q.data ?? []
  const live = meetings.filter((m) => m.can_join)
  const later = meetings.filter((m) => !m.can_join && m.status === 'scheduled')
  const off = meetings.filter((m) => m.status === 'cancelled')

  return (
    <div className="page mt">
      <div className="page-head">
        <div>
          <h1 className="page-title">Meetings</h1>
          <p className="page-sub">
            Book a call against a team or a handful of people. The room opens fifteen minutes
            before the start, and only for the people on the list.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setScheduling(true)}>
          <IconPlus size={15} /> Schedule
        </button>
      </div>

      {failure && <ErrorNote>{failure}</ErrorNote>}

      {meetings.length === 0 ? (
        <section className="card">
          <EmptyState
            icon={<IconUsers size={20} />}
            title="Nothing booked"
            body="Meetings you are invited to appear here. Schedule one to get started."
          />
        </section>
      ) : (
        <>
          {live.length > 0 && (
            <Section heading="Open now" meetings={live} meId={user?.id} onJoin={join} onCancel={cancel} />
          )}
          {later.length > 0 && (
            <Section heading="Coming up" meetings={later} meId={user?.id} onJoin={join} onCancel={cancel} />
          )}
          {off.length > 0 && (
            <Section heading="Cancelled" meetings={off} meId={user?.id} onJoin={join} onCancel={cancel} />
          )}
        </>
      )}

      {scheduling && (
        <ScheduleDialog
          onCancel={() => setScheduling(false)}
          onDone={() => {
            setScheduling(false)
            q.reload()
          }}
        />
      )}
    </div>
  )
}

function Section({
  heading,
  meetings,
  meId,
  onJoin,
  onCancel,
}: {
  heading: string
  meetings: Meeting[]
  meId: string | undefined
  onJoin: (m: Meeting) => Promise<void>
  onCancel: (m: Meeting) => Promise<void>
}) {
  return (
    <section className="card mt-section">
      <div className="card-head">
        <h2 className="card-title">{heading}</h2>
        <span className="card-note">{meetings.length}</span>
      </div>
      <div className="mt-list">
        {meetings.map((meeting) => (
          <Row key={meeting.id} meeting={meeting} meId={meId} onJoin={onJoin} onCancel={onCancel} />
        ))}
      </div>
    </section>
  )
}

function Row({
  meeting,
  meId,
  onJoin,
  onCancel,
}: {
  meeting: Meeting
  meId: string | undefined
  onJoin: (m: Meeting) => Promise<void>
  onCancel: (m: Meeting) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const cancelled = meeting.status === 'cancelled'

  return (
    <div className={`mt-row${cancelled ? ' is-off' : ''}`}>
      <div className="mt-when">
        <span className="mt-when-time">{dateTime(meeting.starts_at)}</span>
        <span className="mt-when-rel">
          {relativeTime(meeting.starts_at)} · {meeting.duration_minutes} min
        </span>
      </div>

      <div className="mt-main">
        <div className="mt-title">{meeting.title}</div>
        <div className="mt-meta">
          {meeting.host_user_id === meId ? 'You' : meeting.host_name ?? 'Somebody'} ·{' '}
          {/* The label the list was seeded from, so a nine-person meeting reads
              as "the Platform team" rather than as nine names. */}
          {meeting.seeded_from
            ? `${meeting.seeded_from} · ${meeting.invitee_count} invited`
            : `${meeting.invitee_count} invited`}
          {meeting.attended_count > 0 && (
            <>
              {' · '}
              <b>
                <IconCheck size={12} /> {meeting.attended_count} joined
              </b>
            </>
          )}
        </div>
        {meeting.agenda && <p className="mt-agenda">{meeting.agenda}</p>}
      </div>

      <div className="mt-actions">
        {cancelled ? (
          <span className="mt-off-tag">Cancelled</span>
        ) : (
          <>
            {meeting.can_join ? (
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  await onJoin(meeting)
                  setBusy(false)
                }}
              >
                Join
              </button>
            ) : (
              <span className="mt-soon" title="The room opens 15 minutes before the start">
                Not open yet
              </span>
            )}
            {meeting.can_cancel && (
              <button
                className="btn"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  await onCancel(meeting)
                  setBusy(false)
                }}
              >
                Cancel
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- room --- */

/**
 * The call itself, in the provider's iframe.
 *
 * Everything about this component is about handing off cleanly and saying so.
 * The banner naming the provider is not decoration: people are entitled to know
 * whose servers their camera is going through, and on the default deployment it
 * is not ours.
 */
function RoomView({
  meeting,
  room,
  onLeave,
}: {
  meeting: Meeting
  room: Room
  onLeave: () => void
}) {
  /* Jitsi takes its per-call configuration in the URL fragment. The fragment is
     never sent to a server, which is the right place for a display name — and
     the room name itself sits in the iframe's src, inside this page, rather
     than in the console's own address bar where it would enter history. */
  const src = useMemo(() => {
    const config = [
      `userInfo.displayName=${encodeURIComponent(JSON.stringify(room.display_name))}`,
      // The prejoin screen is left ON deliberately: it is where somebody checks
      // their camera and mutes before anybody sees them. Skipping it drops
      // people into a live call with the camera already running.
      'config.prejoinPageEnabled=true',
      'config.disableDeepLinking=true',
      // The toolbar, named rather than left to the provider's default.
      //
      // `desktop` is screen sharing, and it is the reason this list exists at
      // all: the default toolbar drops buttons as the window narrows, and
      // screen sharing was the first casualty on a laptop — present on the
      // provider's demo, missing for anybody actually working. Naming the set
      // also means an upstream release cannot quietly add a button that does
      // something this product has not thought about.
      `config.toolbarButtons=${encodeURIComponent(JSON.stringify([
        'microphone', 'camera', 'desktop', 'chat', 'raisehand', 'participants-pane',
        'tileview', 'fullscreen', 'settings', 'videoquality', 'hangup',
      ]))}`,
      // Screen sharing is the point of the button above; asking for the whole
      // screen by default matches what people expect from "share my screen",
      // and the browser still shows its own picker before anything is sent.
      'config.desktopSharingFrameRate.max=15',
    ].join('&')
    return `https://${room.domain}/${encodeURIComponent(room.room)}#${config}`
  }, [room])

  return (
    <div className="page mt-room">
      <div className="mt-room-bar">
        <div>
          <h1 className="mt-room-title">{meeting.title}</h1>
          <p className="mt-room-meta">
            {meeting.invitee_count} invited · video by {room.domain}
          </p>
        </div>
        <button className="btn" onClick={onLeave}>
          <IconClose size={15} /> Back to meetings
        </button>
      </div>

      <iframe
        className="mt-room-frame"
        title={`${meeting.title} — video call`}
        src={src}
        allow="camera; microphone; fullscreen; display-capture; autoplay; speaker-selection"
      />

      <p className="mt-room-note">
        Use <b>Share screen</b> in the toolbar to present a window or your whole screen — the
        browser asks you to pick which, and nothing is shared until you do. The call runs on{' '}
        <b>{room.domain}</b>, which is not part of this console: your camera, microphone and
        anything you share go to that service. Leaving this page ends your side of the call.
      </p>
    </div>
  )
}

/* ------------------------------------------------------------- schedule --- */

function ScheduleDialog({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const teamsQ = useQuery<Team[]>('meet-teams', () => api.get<Team[]>('/org/teams'))
  const peopleQ = useQuery<DirectoryEntry[]>('meet-directory', () =>
    api.get<DirectoryEntry[]>('/people/directory'),
  )
  const { user } = useAuth()

  const [title, setTitle] = useState('')
  const [agenda, setAgenda] = useState('')
  const [when, setWhen] = useState(() => {
    /* Defaulted to the next quarter hour, local. A datetime-local input with
       nothing in it is a form somebody has to fill in twice — once to discover
       the format it wants. */
    const at = new Date(Date.now() + 15 * 60_000)
    at.setMinutes(Math.ceil(at.getMinutes() / 15) * 15, 0, 0)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
  })
  const [duration, setDuration] = useState(30)
  const [teamId, setTeamId] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const needle = query.trim().toLowerCase()
  const people = (peopleQ.data ?? [])
    // The host is added by the server; offering to invite yourself is noise.
    .filter((entry) => entry.user_id !== user?.id)
    .filter((entry) => !needle || entry.full_name.toLowerCase().includes(needle))

  const ready = title.trim().length > 0 && when !== '' && (teamId !== '' || picked.size > 0)

  async function submit() {
    setBusy(true)
    setFailure(null)
    try {
      await api.post('/meetings', {
        title: title.trim(),
        agenda: agenda.trim() || null,
        // The input is local time with no zone; the Date turns it into the
        // instant the server should store.
        starts_at: new Date(when).toISOString(),
        duration_minutes: duration,
        team_id: teamId || null,
        user_ids: [...picked],
      })
      onDone()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'That meeting could not be booked.')
      setBusy(false)
    }
  }

  return (
    <div className="hx-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="hx-dialog mt-dialog" role="dialog" aria-modal="true" aria-label="Schedule a meeting">
        <div className="hx-dialog-head">
          <h2 className="hx-dialog-title">Schedule a meeting</h2>
        </div>

        <div className="mt-form">
          <label className="mt-field mt-field-wide">
            <span className="mt-field-label">Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sprint review" />
          </label>

          <label className="mt-field">
            <span className="mt-field-label">Starts</span>
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </label>

          <label className="mt-field">
            <span className="mt-field-label">Length</span>
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {[15, 30, 45, 60, 90].map((n) => (
                <option key={n} value={n}>{n} minutes</option>
              ))}
            </select>
          </label>

          <label className="mt-field mt-field-wide">
            <span className="mt-field-label">Agenda</span>
            <textarea rows={2} value={agenda} onChange={(e) => setAgenda(e.target.value)}
                      placeholder="Optional — what this is for." />
          </label>

          <label className="mt-field mt-field-wide">
            <span className="mt-field-label">Invite a whole team</span>
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">No team — pick people below</option>
              {(teamsQ.data ?? []).map((team) => (
                <option key={team.id} value={team.id}>{team.name}</option>
              ))}
            </select>
            <span className="mt-field-hint">
              The list is taken now and then fixed. People who join the team later are not
              added to this meeting.
            </span>
          </label>
        </div>

        <div className="mt-people">
          <div className="mt-people-head">
            <span className="mt-field-label">And these people</span>
            <span className="mt-people-count">{picked.size} picked</span>
          </div>
          <input
            type="search"
            value={query}
            placeholder="Search the directory…"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search people to invite"
          />
          <div className="mt-people-list">
            {peopleQ.loading && <Loading />}
            {people.map((entry) => (
              <label className="mt-person" key={entry.user_id}>
                <input
                  type="checkbox"
                  checked={picked.has(entry.user_id)}
                  onChange={() =>
                    setPicked((current) => {
                      const next = new Set(current)
                      if (next.has(entry.user_id)) next.delete(entry.user_id)
                      else next.add(entry.user_id)
                      return next
                    })
                  }
                />
                <Avatar name={entry.full_name} small />
                <span className="mt-person-body">
                  <span className="mt-person-name">{entry.full_name}</span>
                  <span className="mt-person-meta">
                    {[entry.designation, entry.department].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {failure && <div className="mt-form-error"><ErrorNote>{failure}</ErrorNote></div>}

        <div className="hx-dialog-foot mt-foot">
          <p className="mt-foot-note">You are always in the room you book.</p>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? 'Booking…' : 'Schedule'}
          </button>
        </div>
      </div>
    </div>
  )
}
