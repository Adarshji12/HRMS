import { useEffect, useState } from 'react'
import { fetchImage } from '../lib/api'
import { useAuth } from '../lib/auth'

/* The LRS logo is the default brand; companies may still show their own logo. */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <img
      className="brand-mark"
      src="/LRS%20logo.png"
      alt="LRS Services"
      style={{ height: size, width: 'auto', maxWidth: '100%' }}
    />
  )
}

/**
 * The company's own logo, where it has uploaded one.
 *
 * It does its own fetching rather than using `AuthedImage`, for one reason:
 * this has to fail *invisibly*. AuthedImage renders an "Image unavailable" box,
 * which is the right answer for a missing screenshot in a gallery and the wrong
 * one for the lockup at the top of every page — a storage hiccup would put an
 * error message where the brand goes, on every screen at once. Here a failure
 * falls back to the product mark, which is a working console either way.
 *
 * `stamp` is the tenant's `logo_updated_at`, hung on the URL. The endpoint is a
 * per-tenant singleton at one unchanging path, so without it a replaced logo
 * would keep serving the old image out of the browser's cache.
 */
function CompanyMark({
  stamp,
  name,
  size,
  onFail,
}: {
  stamp: string
  name: string
  size: number
  onFail: () => void
}) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    fetchImage(`/api/v1/org/company/logo?v=${encodeURIComponent(stamp)}`)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url)
          return
        }
        objectUrl = url
        setSrc(url)
      })
      .catch(() => !cancelled && onFail())
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
    // `onFail` is a setState updater from the parent and stable enough; keying
    // the effect on it would re-fetch the logo on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp])

  /* Nothing while it loads, rather than a spinner or the product mark: this is
     a 30px image on a fast local request, and either alternative would flash
     something else into the lockup for a frame and read as a glitch. The box is
     held open so the nav below it does not jump when the image lands. */
  if (!src) return <span className="brand-logo brand-logo-empty" style={{ height: size }} />
  return <img className="brand-logo" src={src} alt={name} style={{ maxHeight: size }} />
}

/**
 * The lockup at the top of the rail.
 *
 * It shows the company's logo where one has been uploaded and the MyDeskTime
 * mark where one has not. Two conditions gate the swap and both matter:
 *
 * - **A signed-in user.** The logo endpoint needs a token, and this component
 *   also renders on the sign-in and sign-up pages, where there is none. Asking
 *   there would be a guaranteed 401 on every visit to the login screen.
 * - **A stamp.** `logo_updated_at` is null for every company that has not
 *   uploaded one, which is most of them, and null means "do not ask".
 */
export default function Brand({ size = 30 }: { size?: number }) {
  const { user, organization } = useAuth()
  const [failed, setFailed] = useState(false)
  const stamp = organization?.logo_updated_at ?? null

  // A new logo deserves a fresh attempt; without this, one failure would pin
  // the product mark in place for the rest of the session.
  useEffect(() => setFailed(false), [stamp])

  if (user && stamp && !failed) {
    return (
      <div className="brand brand-company">
        <CompanyMark
          stamp={stamp}
          name={organization?.name ?? 'Company logo'}
          size={size}
          onFail={() => setFailed(true)}
        />
      </div>
    )
  }

  return (
    <div className="brand">
      <BrandMark size={size} />
    </div>
  )
}
