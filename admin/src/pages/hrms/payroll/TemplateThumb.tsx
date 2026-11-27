import { useEffect, useRef, useState } from 'react'
import { Loading } from '../../../components/ui'

/**
 * A template's preview, scaled to whatever width its card has. The page is drawn 800px wide in a frame and shrunk to
 * fit, so the thumbnail fills the card whether four or five sit in a row.
 */
export default function TemplateThumb({ html, title }: { html: string | undefined; title: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(200)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth || 200)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={box} style={{ height: Math.round(width * 1.05), overflow: 'hidden', background: '#eef2f6', borderRadius: 8, position: 'relative' }}>
      {html ? <iframe title={title} srcDoc={html} tabIndex={-1}
                      style={{ width: 800, height: 1100, border: 0, transform: `scale(${width / 800})`, transformOrigin: 'top left', pointerEvents: 'none' }} />
        : <Loading />}
    </div>
  )
}
