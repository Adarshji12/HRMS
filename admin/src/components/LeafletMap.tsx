import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

export interface MapMarker { lat: number; lng: number; label: string; tone?: 'good' | 'warn' | 'muted' | 'start' | 'end'; onClick?: () => void }

/**
 * A plain Leaflet map: an optional path and a set of labelled markers, fitted to what it shows.
 *
 * Tiles come from OpenStreetMap, which refuses requests that carry no referrer, so the layer sends
 * the page's origin explicitly.
 */
export default function LeafletMap({ path, markers, height = 460, focus }: {
  path?: Array<[number, number]>; markers?: MapMarker[]; height?: number; focus?: [number, number] | null
}) {
  const host = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layer = useRef<L.LayerGroup | null>(null)

  useEffect(() => {
    if (!host.current || map.current) return
    const m = L.map(host.current, { center: [22.5, 79], zoom: 4, zoomControl: true })
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, referrerPolicy: 'origin', attribution: '© OpenStreetMap',
    }).addTo(m)
    layer.current = L.layerGroup().addTo(m)
    map.current = m
    return () => { m.remove(); map.current = null }
  }, [])

  useEffect(() => {
    const m = map.current
    const group = layer.current
    if (!m || !group) return
    group.clearLayers()
    const bounds: L.LatLngTuple[] = []
    if (path && path.length > 1) {
      L.polyline(path, { color: '#0f9d8a', weight: 4, opacity: 0.85 }).addTo(group)
      bounds.push(...path)
    }
    for (const mk of markers ?? []) {
      const icon = L.divIcon({
        className: 'lm-pin-wrap',
        html: `<span class="lm-pin lm-${mk.tone ?? 'good'}"></span>`,
        iconSize: [18, 18], iconAnchor: [9, 9],
      })
      const marker = L.marker([mk.lat, mk.lng], { icon, title: mk.label }).addTo(group)
      marker.bindTooltip(mk.label)
      if (mk.onClick) marker.on('click', mk.onClick)
      bounds.push([mk.lat, mk.lng])
    }
    if (bounds.length === 1) m.setView(bounds[0], 15)
    else if (bounds.length > 1) m.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 })
  }, [path, markers])

  useEffect(() => {
    if (focus && map.current) map.current.setView(focus, 16)
  }, [focus])

  return <div ref={host} className="lm-map" style={{ height }} />
}
