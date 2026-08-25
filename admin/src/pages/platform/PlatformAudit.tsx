import { useEffect, useMemo, useState } from 'react'
import { platformApi, type AuditItem } from '../../lib/platformApi'
import { dateTime } from '../../lib/format'

/**
 * Who did what, across every customer.
 *
 * The audit table has existed since the first migration — the product's own
 * accountability surface, required by most works-council and GDPR reviews
 * because a monitoring system must itself be auditable. It had no reader until
 * now, which made it a compliance claim nobody could check.
 */

const NOTABLE = new Set([
  'screenshot.viewed',
  'screenshot.deleted',
  'settings.updated',
  'employee.key_rotated',
  'device.revoked',
  'platform.company_suspended',
  'platform.mail_configured',
  'mail.configured',
])

export default function PlatformAudit() {
  const [items, setItems] = useState<AuditItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [action, setAction] = useState('')
  const [onlyNotable, setOnlyNotable] = useState(false)

  useEffect(() => {
    platformApi.audit({ limit: 200 }).then(setItems).catch((e) => setError(String(e)))
  }, [])

  const rows = useMemo(() => {
    let out = items ?? []
    if (onlyNotable) out = out.filter((i) => NOTABLE.has(i.action))
    const needle = action.trim().toLowerCase()
    if (needle) {
      out = out.filter(
        (i) =>
          i.action.toLowerCase().includes(needle) ||
          (i.organization ?? '').toLowerCase().includes(needle) ||
          (i.actor ?? '').toLowerCase().includes(needle),
      )
    }
    return out
  }, [items, action, onlyNotable])

  if (error) return <div className="pf-error">{error}</div>

  return (
    <div>
      <div className="pf-head">
        <div>
          <h1 className="pf-title">Activity log</h1>
          <p className="pf-sub">
            Policy changes, screenshot views, key rotations and suspensions — across
            every customer. This is the record that makes the monitoring itself
            auditable.
          </p>
        </div>
      </div>

      <div className="pf-filters">
        <input
          type="search"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder="Filter by action, company or person…"
        />
        <label className="pf-check">
          <input
            type="checkbox"
            checked={onlyNotable}
            onChange={(e) => setOnlyNotable(e.target.checked)}
          />
          {/* Logins dominate the raw feed and tell you almost nothing. */}
          <span>Only sensitive actions</span>
        </label>
        <span className="pf-muted">{rows.length} of {items?.length ?? 0}</span>
      </div>

      <div className="pf-card">
        {items === null ? (
          <p className="pf-muted" style={{ padding: 16 }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p className="pf-muted" style={{ padding: 16 }}>Nothing matches.</p>
        ) : (
          <div className="pf-table-wrap">
            <table className="pf-table">
              <thead>
                <tr><th>When</th><th>Action</th><th>Company</th><th>Who</th><th>Target</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.at}-${i}`} className={NOTABLE.has(r.action) ? 'pf-row-notable' : undefined}>
                    <td className="pf-nowrap">{dateTime(r.at)}</td>
                    <td><code className="pf-code">{r.action}</code></td>
                    <td>{r.organization}</td>
                    <td>{r.actor}</td>
                    <td className="pf-muted">
                      {r.target_type}
                      {r.detail ? ` · ${JSON.stringify(r.detail).slice(0, 60)}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
