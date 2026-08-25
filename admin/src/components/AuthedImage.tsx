import { useEffect, useState } from 'react'
import { fetchImage } from '../lib/api'

/**
 * Screenshot endpoints require a bearer token, which a plain `<img src>` cannot
 * send. Fetch the blob, hand the element an object URL, and revoke it on unmount
 * so a long screenshot-scrolling session does not leak memory.
 */
export function AuthedImage({
  path,
  alt,
  className,
}: {
  path: string
  alt: string
  className?: string
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false

    fetchImage(path)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url)
          return
        }
        objectUrl = url
        setSrc(url)
      })
      .catch(() => !cancelled && setFailed(true))

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path])

  if (failed) {
    return (
      <div className={className} style={{ display: 'grid', placeItems: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
        Image unavailable
      </div>
    )
  }
  if (!src) return <div className={className} />
  return <img className={className} src={src} alt={alt} loading="lazy" />
}
