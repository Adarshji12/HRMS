import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import '../styles/hrsettings.css'
import '../styles/tracking.css'
import { IconPin } from './Icons'

const KEY = 'hr.share-location'
const EVERY_MS = 60_000

/**
 * Lets a person share their position with the people who manage them, for as long as this page is
 * open. It is a choice they make and can undo at any moment; nothing is read until it is on.
 */
export default function LocationSharing() {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(KEY) === '1' } catch { return false } })
  const [note, setNote] = useState<string | null>(null)
  const latest = useRef<GeolocationPosition | null>(null)

  useEffect(() => {
    try { localStorage.setItem(KEY, on ? '1' : '0') } catch { /* private window */ }
    if (!on) return
    if (!('geolocation' in navigator)) { setNote('This browser cannot share a location.'); return }
    const watch = navigator.geolocation.watchPosition(
      (pos) => { latest.current = pos; setNote(null) },
      (err) => setNote(err.code === err.PERMISSION_DENIED ? 'Location permission was refused in the browser.' : 'Your position is not available right now.'),
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 30_000 },
    )
    const send = () => {
      const pos = latest.current
      if (!pos) return
      latest.current = null
      void api.post('/location/pings', { points: [{
        lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy_m: pos.coords.accuracy,
        speed_mps: pos.coords.speed ?? null, at: new Date(pos.timestamp).toISOString(),
      }] }).catch(() => undefined)
    }
    const first = window.setTimeout(send, 4000)
    const timer = window.setInterval(send, EVERY_MS)
    return () => { navigator.geolocation.clearWatch(watch); window.clearTimeout(first); window.clearInterval(timer) }
  }, [on])

  return (
    <div className="card ls-card">
      <div>
        <b><IconPin size={15} /> Share my location</b>
        <p className="muted-sm">{note ?? (on ? 'Your position goes to your manager about once a minute while this page stays open.' : 'Off. Turn it on to let your manager see where you are while you work.')}</p>
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label="Share my location" className={`hs-switch${on ? ' is-on' : ''}`} onClick={() => setOn(!on)}><span /></button>
    </div>
  )
}
