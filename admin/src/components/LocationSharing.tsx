import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import '../styles/hrsettings.css'
import '../styles/tracking.css'
import { useQuery } from '../lib/useQuery'

const EVERY_MS = 60_000

/**
 * Lets a person share their position with the people who manage them, for as long as this page is
 * open. It is a choice they make and can undo at any moment; nothing is read until it is on.
 */
export default function LocationSharing() {
  const on = true
  const [note, setNote] = useState<string | null>(null)
  const latest = useRef<GeolocationPosition | null>(null)
  // HR switches GPS tracking on or off for the whole company (HR Settings > Attendance). Off: no switch, no watching.
  const policy = useQuery<{ gps_tracking_enabled?: boolean }>('att-gps-policy', () => api.get<{ gps_tracking_enabled?: boolean }>('/attendance/settings'))
  const allowed = policy.data?.gps_tracking_enabled !== false

  useEffect(() => {
    if (!on || !allowed) return
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
  }, [on, allowed])

  /* No control on the employee side: HR Settings > Attendance decides, and the browser asks for permission itself. */
  return note && allowed ? <p className="muted-sm">{note}</p> : null
}
