import { useEffect, useMemo, useState } from 'react'
import { api, download } from '../lib/api'
import { dateTime } from '../lib/format'
import type { User } from '../lib/types'
import { ErrorNote, Loading } from './ui'
import { IconCheck, IconDownload } from './Icons'

/**
 * Download the agent, and the instructions for installing it.
 *
 * These two things were split across a deployment document and a README inside
 * the zip, neither of which the administrator doing the onboarding was reading.
 * The result was the enrolment key being sent without the installer, or the
 * installer without the server address. They belong in the same place as the
 * key itself, which is this console.
 *
 * Opened for a specific employee, it fills their key in and the whole thing
 * becomes a message that can be pasted into an email as-is. Opened from the
 * page header, it is the generic version, for sending the software ahead of
 * deciding who gets it.
 */

interface AgentBundle {
  name: string
  platform: string
  requirement: string
  size: number
  modified_at: string
  sha256: string
}

interface BundleList {
  bundles: AgentBundle[]
  /** Null when unconfigured — the console's own origin is then the answer. */
  server_url: string | null
  /** Archives present but not offered, because their names name no platform. */
  ignored: string[]
}

function megabytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The steps, in one place, so the screen and the copyable text cannot drift. */
function steps(serverUrl: string, key: string | null): string[] {
  return [
    'Unzip the whole folder somewhere permanent — Desktop or Documents. ' +
      'The files do not work on their own, so keep them together.',
    'Double-click MyDeskTime-Setup.exe.',
    `When it asks for the server, press Enter to accept ${serverUrl}.`,
    key
      ? `Paste this enrolment key when asked: ${key}`
      : 'Paste the enrolment key your administrator gave you.',
    'Type accept when the monitoring notice appears.',
    'Done. Tracking starts immediately and again at every sign-in. ' +
      'A small icon appears near the clock — right-click it to see what is ' +
      'recorded, or to stop tracking.',
  ]
}

export default function AgentInstall({
  employee,
  onClose,
}: {
  /** When given, their key is shown inline and the copy is addressed to them. */
  employee?: User | null
  onClose: () => void
}) {
  const [data, setData] = useState<BundleList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<BundleList>('/admin/agent/bundles')
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load downloads'))
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Configuration wins; otherwise the address the administrator is already
  // looking at, which is the right one whenever the console and API share a
  // host — as they do behind the bundled nginx.
  const serverUrl = data?.server_url ?? window.location.origin
  const key = employee?.enrollment_key ?? null

  const instructions = useMemo(() => {
    const lines = [
      employee ? `MyDeskTime setup — ${employee.full_name}` : 'MyDeskTime setup',
      '',
      ...steps(serverUrl, key).map((step, index) => `${index + 1}. ${step}`),
      '',
      'If Windows says the publisher is unknown, click "More info" then "Run anyway".',
    ]
    return lines.join('\n')
  }, [employee, serverUrl, key])

  async function copy(what: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 2000)
    } catch {
      setError('The browser refused clipboard access — select the text and copy it manually.')
    }
  }

  async function get(bundle: AgentBundle) {
    setBusy(bundle.name)
    setError(null)
    try {
      await download(`/admin/agent/bundles/${encodeURIComponent(bundle.name)}/download`, bundle.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="hx-backdrop" onMouseDown={onClose}>
      <div className="hx-dialog agent-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="hx-dialog-head">
          <h2 className="hx-dialog-title">
            {employee ? `Set up tracking for ${employee.full_name}` : 'Install the agent'}
          </h2>
          <p className="muted-sm">
            One download, run once on the employee's machine. It starts by itself at
            every sign-in afterwards.
          </p>
        </div>

        <div className="hx-list agent-body">
          {error && <div style={{ marginBottom: 12 }}><ErrorNote>{error}</ErrorNote></div>}

          {!data && !error && <Loading label="Looking for builds…" />}

          {data && (
            <>
              <h3 className="perm-heading">1 · Download</h3>
              {data.bundles.length === 0 ? (
                <div className="agent-missing">
                  <b>No agent build is on this server yet.</b>
                  <p>
                    Whoever deploys MyDeskTime needs to copy the packaged bundle into the
                    agent downloads directory — see <code>DEPLOYMENT.md</code>. Until then
                    the installer has to be sent by hand.
                  </p>
                  {data.ignored.length > 0 && (
                    /* Almost always the real cause: the file is there, under a
                       name that does not say which platform it is for. */
                    <p className="muted-sm">
                      {data.ignored.length} archive(s) in that directory were skipped
                      because their names do not say which platform they are for:{' '}
                      {data.ignored.join(', ')}. Rename to include{' '}
                      <code>windows</code>, <code>macos</code> or <code>linux</code>.
                    </p>
                  )}
                </div>
              ) : (
                <div className="agent-bundles">
                  {data.bundles.map((bundle) => (
                    <div className="agent-bundle" key={bundle.name}>
                      <div className="agent-bundle-body">
                        <div className="agent-bundle-name">MyDeskTime for {bundle.platform}</div>
                        <div className="muted-sm">
                          {megabytes(bundle.size)}
                          {bundle.requirement ? ` · ${bundle.requirement}` : ''} · built{' '}
                          {dateTime(bundle.modified_at)}
                        </div>
                        {/* The binaries are not code-signed, so Windows calls the
                            publisher unknown. A hash somebody can check is the only
                            assurance on offer until a certificate exists. */}
                        <div className="agent-hash" title="SHA-256 of the download">
                          <code>{bundle.sha256.slice(0, 32)}…</code>
                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={() => copy(`hash:${bundle.name}`, bundle.sha256)}
                          >
                            {copied === `hash:${bundle.name}` ? 'Copied' : 'Copy SHA-256'}
                          </button>
                        </div>
                      </div>
                      <button
                        className="btn btn-primary"
                        disabled={busy === bundle.name}
                        onClick={() => get(bundle)}
                      >
                        <IconDownload size={15} />
                        {busy === bundle.name ? 'Downloading…' : 'Download'}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <h3 className="perm-heading">
                2 · What the employee does
                <span className="perm-note">
                  Run once. Nothing else on the machine ever needs opening.
                </span>
              </h3>

              <div className="agent-facts">
                <div className="agent-fact">
                  <span className="agent-fact-label">Server address</span>
                  <code>{serverUrl}</code>
                  <button className="btn btn-sm btn-ghost" onClick={() => copy('server', serverUrl)}>
                    {copied === 'server' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                {/* The one per-person secret in the whole flow. Shown here only
                    when the dialog was opened for somebody, so the generic
                    version cannot leak one by being left on screen. */}
                {employee && (
                  <div className="agent-fact">
                    <span className="agent-fact-label">Enrolment key</span>
                    <code className="key-chip">{key}</code>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => copy('key', key ?? '')}
                    >
                      {copied === 'key' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                )}
              </div>

              <ol className="agent-steps">
                {steps(serverUrl, key).map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>

              <div className="agent-note">
                <b>If Windows says the publisher is unknown</b> — click “More info”, then
                “Run anyway”. The binaries are not code-signed yet; the SHA-256 above is
                what confirms the file is the one this server is serving.
              </div>

              {employee && !employee.notice_accepted_at && (
                <div className="agent-note agent-note-warn">
                  <b>{employee.full_name} has not accepted the monitoring notice.</b>{' '}
                  Enrolment is refused until they do — it is step 5, and it happens on
                  their machine, not here.
                </div>
              )}
            </>
          )}
        </div>

        <div className="hx-dialog-foot">
          {data && data.bundles.length > 0 && (
            <button
              className="btn"
              onClick={() => copy('all', instructions)}
              title="The steps above, as text to paste into an email"
            >
              {copied === 'all' ? <><IconCheck size={15} /> Copied</> : 'Copy instructions'}
            </button>
          )}
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
