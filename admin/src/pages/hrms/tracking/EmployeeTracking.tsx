/* Employee Tracking: where the team is now (Live Tracking) and the route one person took on a day
 * (Route History). Positions are shared by the employees themselves from My attendance. */

import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import '../../../styles/tracking.css'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import { IconCalendar, IconPin, IconUsers } from '../../../components/Icons'
import LeafletMap, { type MapMarker } from '../../../components/LeafletMap'

interface Person { id: string; name: string }
interface LivePerson { user_id: string; name: string; lat: number; lng: number; at: string; state: 'reporting' | 'earlier'; moving: boolean }
interface Live { now: string; reporting: number; earlier: number; moving: number; people: LivePerson[] }
interface Route {
  points: Array<{ lat: number; lng: number; at: string }>
  punches: Array<{ kind: 'in' | 'out'; lat: number; lng: number; at: string }>
  distance_km: number; first_at: string | null; last_at: string | null
}

type Tab = 'route' | 'live'

export default function EmployeeTracking() {
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'live' ? 'live' : 'route'
  const go = (next: Tab) => setParams({ tab: next }, { replace: true })
  return (
    <div className="tk">
      <div className="page-head">
        <div>
          <h1 className="page-title">Employee Tracking</h1>
          <p className="page-sub">Where the team is now, and the route they took on any day</p>
        </div>
      </div>
      <nav className="tk-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'route'} className={`tk-tab${tab === 'route' ? ' is-on' : ''}`} onClick={() => go('route')}>
          <IconPin size={15} /> Route History
        </button>
        <button role="tab" aria-selected={tab === 'live'} className={`tk-tab${tab === 'live' ? ' is-on' : ''}`} onClick={() => go('live')}>
          <IconUsers size={15} /> Live Tracking
        </button>
      </nav>
      {tab === 'route' ? <RouteHistory /> : <LiveTracking />}
    </div>
  )
}

const pad = (n: number) => String(n).padStart(2, '0')
const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const dmy = (iso: string) => iso.split('-').reverse().join('/')
const hm = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })

const PARTS: Array<{ key: string; label: string; from: string; to: string }> = [
  { key: 'all', label: 'All day', from: '00:00', to: '23:59' },
  { key: 'morning', label: 'Morning', from: '05:00', to: '11:59' },
  { key: 'afternoon', label: 'Afternoon', from: '12:00', to: '16:59' },
  { key: 'evening', label: 'Evening', from: '17:00', to: '23:59' },
]

function RouteHistory() {
  const people = useQuery<Person[]>('tracking-people', () => api.get<Person[]>('/tracking/people'))
  const [userId, setUserId] = useState('')
  const [day, setDay] = useState(toIso(new Date()))
  const [part, setPart] = useState('all')
  const [custom, setCustom] = useState(false)
  const [from, setFrom] = useState('09:00')
  const [to, setTo] = useState('18:00')
  const today = toIso(new Date())

  const range = custom ? { from, to } : PARTS.find((p) => p.key === part)!
  const route = useQuery<Route>(`tracking-route:${userId}:${day}:${range.from}:${range.to}`,
    () => api.get<Route>(`/tracking/route?user_id=${userId}&date=${day}&start=${range.from}&end=${range.to}`),
    { enabled: Boolean(userId) })

  const shift = (by: number) => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + by); setDay(toIso(d)) }

  const path = useMemo(() => (route.data?.points ?? []).map((p) => [p.lat, p.lng] as [number, number]), [route.data])
  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = []
    const pts = route.data?.points ?? []
    if (pts.length) {
      out.push({ lat: pts[0].lat, lng: pts[0].lng, label: `Start ${hm(pts[0].at)}`, tone: 'start' })
      if (pts.length > 1) out.push({ lat: pts[pts.length - 1].lat, lng: pts[pts.length - 1].lng, label: `Latest ${hm(pts[pts.length - 1].at)}`, tone: 'end' })
    }
    for (const p of route.data?.punches ?? []) out.push({ lat: p.lat, lng: p.lng, label: `Punched ${p.kind} ${hm(p.at)}`, tone: p.kind === 'in' ? 'good' : 'warn' })
    return out
  }, [route.data])

  const hasAnything = Boolean(route.data && (route.data.points.length || route.data.punches.length))

  return (
    <div className="tk-split">
      <section className="card tk-filters">
        <header className="tk-card-head"><h2>Filters</h2><span className="muted-sm">{people.data?.length ?? 0} people</span></header>
        <div className="tk-filter-body">
          <div className="tk-label">EMPLOYEE</div>
          <select className="tk-select" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose an employee</option>
            {(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <div className="tk-label-row"><span className="tk-label">DATE</span><button type="button" className="tk-link" onClick={() => setDay(today)}>Today</button></div>
          <div className="tk-date">
            <button type="button" className="tk-step" aria-label="Previous day" onClick={() => shift(-1)}>‹</button>
            <label className="tk-day"><IconCalendar size={15} /> <b>{dmy(day)}</b>
              <input type="date" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} />
            </label>
            <button type="button" className="tk-step" aria-label="Next day" disabled={day >= today} onClick={() => shift(1)}>›</button>
          </div>

          <div className="tk-label-row"><span className="tk-label">TIME OF DAY</span>
            <button type="button" className="tk-link" onClick={() => setCustom(!custom)}>{custom ? 'Presets' : 'Custom range'}</button></div>
          {custom ? (
            <div className="tk-range">
              <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
              <span>to</span>
              <input type="time" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
            </div>
          ) : (
            <div className="tk-parts">
              {PARTS.map((p) => (
                <button key={p.key} type="button" className={`tk-part${part === p.key ? ' is-on' : ''}`} onClick={() => setPart(p.key)}>{p.label}</button>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="card tk-route">
        <header className="tk-card-head">
          <h2>Route</h2>
          {route.data && hasAnything && <span className="muted-sm">{route.data.distance_km} km · {route.data.points.length} positions{route.data.first_at && route.data.last_at ? ` · ${hm(route.data.first_at)} – ${hm(route.data.last_at)}` : ''}</span>}
        </header>
        {!userId ? (
          <div className="tk-empty"><IconPin size={22} /><p>Choose an employee and a date to draw their route.</p></div>
        ) : route.error ? (
          <ErrorNote>{route.error}</ErrorNote>
        ) : route.loading && !route.data ? (
          <Loading />
        ) : !hasAnything ? (
          <div className="tk-empty"><IconPin size={22} /><p>No positions were shared by this person in that window.</p></div>
        ) : (
          <LeafletMap path={path} markers={markers} height={520} />
        )}
      </section>
    </div>
  )
}

function LiveTracking() {
  const live = useQuery<Live>('tracking-live', () => api.get<Live>('/tracking/live'), { pollMs: 30_000 })
  const [focus, setFocus] = useState<[number, number] | null>(null)
  const data = live.data

  const markers = useMemo<MapMarker[]>(() => (data?.people ?? []).map((p) => ({
    lat: p.lat, lng: p.lng, label: `${p.name} · ${hm(p.at)}${p.moving ? ' · moving' : ''}`,
    tone: p.state === 'reporting' ? 'good' : 'muted', onClick: () => setFocus([p.lat, p.lng]),
  })), [data])

  if (live.error) return <ErrorNote>{live.error}</ErrorNote>
  if (!data) return <Loading />

  return (
    <>
      <div className="tk-stats">
        <div className="tk-stat"><b>{data.reporting}</b><span>Reporting now</span></div>
        <div className="tk-stat"><b>{data.earlier}</b><span>Last seen earlier</span></div>
        <div className="tk-stat"><b>{data.moving}</b><span>Moving</span></div>
        <div className="tk-stat"><b>{hm(data.now)}</b><span>Refreshed · every 30s</span></div>
      </div>
      <div className="tk-live">
        <section className="card tk-people">
          <header className="tk-card-head"><h2><IconUsers size={15} /> People</h2><span className="muted-sm">updated {hm(data.now)}</span></header>
          {data.people.length === 0 ? (
            <Empty>Nobody has reported a position in the last 12 hours.</Empty>
          ) : (
            <ul className="tk-list">
              {data.people.map((p) => (
                <li key={p.user_id}>
                  <button type="button" onClick={() => setFocus([p.lat, p.lng])}>
                    <span className={`tk-dot ${p.state === 'reporting' ? 'is-on' : ''}`} />
                    <span className="tk-who"><b>{p.name}</b><span className="muted-sm">{p.state === 'reporting' ? (p.moving ? 'Moving' : 'Reporting') : 'Last seen'} · {hm(p.at)}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card tk-map">
          <header className="tk-card-head"><h2>Where everybody is</h2><span className="muted-sm">positions older than 15 min are “last seen”</span></header>
          <LeafletMap markers={markers} focus={focus} height={520} />
          {data.people.length === 0 && <p className="tk-overlay muted-sm">No positions have been reported yet.</p>}
        </section>
      </div>
    </>
  )
}
