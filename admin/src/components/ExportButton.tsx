import { useState } from 'react'
import { download } from '../lib/api'
import { IconDownload } from './Icons'

/**
 * One export control for the whole console.
 *
 * It exists as a component rather than a `<button onClick={download}>` in each
 * page for two reasons that only show up in use: a CSV of a month of segments
 * takes long enough that an unchanged button reads as a dead click, and a
 * failed download otherwise fails silently — `download()` throws into a promise
 * nobody awaited, so the user learns nothing and tries again.
 *
 * `href` must already carry the page's filters. An export that ignores the
 * filters above it is worse than no export: the file looks like the answer to
 * the question on screen and is not.
 */
export function ExportButton({
  href,
  filename,
  label = 'Export CSV',
  disabled,
  title,
}: {
  href: string
  filename: string
  label?: string
  disabled?: boolean
  title?: string
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setError(null)
    try {
      await download(href, filename)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="export-wrap">
      <button
        className="btn"
        onClick={run}
        disabled={disabled || busy}
        title={title ?? (disabled ? 'Nothing to export' : `Download ${filename}`)}
      >
        <IconDownload size={15} />
        {busy ? 'Preparing…' : label}
      </button>
      {error && <span className="export-error" role="alert">{error}</span>}
    </span>
  )
}
