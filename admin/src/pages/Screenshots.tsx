import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { canAdminister, useAuth, canViewTeam } from '../lib/auth'
import { clockTime, dateTime, daysAgoISO, todayISO } from '../lib/format'
import type { Department, OrgSettings, ScreenshotItem, Team, User } from '../lib/types'
import { DatePresets, type Range } from '../components/DatePresets'
import { AuthedImage } from '../components/AuthedImage'
import { EmptyState, ErrorNote, Loading, ProductivityBadge } from '../components/ui'
import { IconCamera } from '../components/Icons'
import { ExportButton } from '../components/ExportButton'

interface Listing {
  total: number
  timezone: string
  items: ScreenshotItem[]
}

export default function Screenshots() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const search = params.toString()
  /* A range, not a day. "Show me last Tuesday afternoon and Wednesday" used to
     be two searches with no way to export both; `to` defaults to `from` so the
     single-day case still costs one field. */
  const from = params.get('from') ?? params.get('day') ?? todayISO()
  const to = params.get('to') ?? from
  const userFilter = params.get('user') ?? ''
  const teamFilter = params.get('team') ?? ''
  const deptFilter = params.get('dept') ?? ''
  const [active, setActive] = useState<ScreenshotItem | null>(null)

  const employees = useQuery<User[]>('employees', () => api.get<User[]>('/admin/employees'))
  const settings = useQuery<OrgSettings>('settings', () => api.get<OrgSettings>('/admin/settings'))
  const teams = useQuery<Team[]>('teams', () => api.get<Team[]>('/org/teams'))
  const departments = useQuery<Department[]>('departments', () =>
    api.get<Department[]>('/org/departments'),
  )

  // DatePresets owns a {start,end,preset} shape; the URL is the source of truth,
  // so the preset is re-derived rather than remembered. Anything that is not one
  // of the named windows is "custom", which is exactly what a hand-edited link is.
  const range: Range = {
    start: from,
    end: to,
    preset: from === to && to === todayISO()
      ? 'today'
      : from === to && to === daysAgoISO(1)
        ? 'yesterday'
        : 'custom',
  }

  const query = new URLSearchParams({ start: from, end: to })
  if (userFilter) query.set('user_id', userFilter)
  if (teamFilter) query.set('team_id', teamFilter)
  if (deptFilter) query.set('department_id', deptFilter)
  const qs = query.toString()

  const { data, error, loading, refetching, reload } = useQuery<Listing>(
    `shots:${qs}`,
    () => api.get<Listing>(`/admin/screenshots?${qs}`),
  )

  const filtered = userFilter || teamFilter || deptFilter || to !== from

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setActive(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  const nameFor = (id: string) =>
    employees.data?.find((e) => e.id === id)?.full_name ?? 'Unknown'

  return (
    <div className={refetching ? 'refetching' : undefined}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Screenshots</h1>
          <p className="page-sub">
            Every capture shows the exact time it was taken. Opening one full-size is recorded in
            the audit log.
          </p>
        </div>
        <div className="head-actions">
          {/* Metadata, not the images: a CSV cannot carry JPEGs, and bulk image
              extraction is a data-protection decision rather than a button. */}
          <ExportButton
            href={`/admin/screenshots/export.csv?${qs}`}
            filename={`screenshots-${from}-to-${to}.csv`}
            label="Export index"
            disabled={!data || data.total === 0}
          />
        </div>
      </div>

      {settings.data && !settings.data.screenshot_enabled && (
        <div className="notice" style={{ marginBottom: 16 }}>
          Screenshot capture is currently <b>disabled</b> for this organisation. Existing captures
          are still listed until their retention period ends.
        </div>
      )}

      <div className="filter-row">
        {/* The shared control, like every other date-scoped page. It was raw
            From/To inputs cross-constrained with min/max, which locked the page
            shut: both start on today, so the To field's min was today, and a
            browser date picker simply refuses to offer yesterday — no error, no
            explanation, just nothing. Reaching for "To" first was a dead end,
            and "yesterday" is the single most common thing anyone wants here. */}
        <DatePresets
          value={range}
          onChange={(next) => {
            const params = new URLSearchParams(search)
            params.set('from', next.start)
            params.set('to', next.end)
            setParams(params, { replace: true })
          }}
        />
        {/* Only for someone who can look at more than themselves. An
            employee's list contains exactly one name — their own — so this
            rendered a chooser labelled "Everyone" with one entry, which reads
            as a broken feature rather than an absent one. The server refuses
            the request either way. */}
        {canViewTeam(user) && (
          <>
            <label className="field">
              Employee
              <select value={userFilter} onChange={(e) => setParam('user', e.target.value)}>
                <option value="">Everyone</option>
                {employees.data?.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.full_name}
                  </option>
                ))}
              </select>
            </label>
            <select
              value={teamFilter}
              onChange={(e) => setParam('team', e.target.value)}
              aria-label="Team"
            >
              <option value="">All teams</option>
              {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select
              value={deptFilter}
              onChange={(e) => setParam('dept', e.target.value)}
              aria-label="Department"
            >
              <option value="">All departments</option>
              {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </>
        )}
        {filtered && (
          <button
            className="filter-reset"
            onClick={() => setParams(new URLSearchParams(), { replace: true })}
          >
            Clear filters
          </button>
        )}
        <span className="filter-spacer" />
        {settings.data && (
          <span className="card-note">
            interval {Math.round(settings.data.screenshot_interval_s / 60)} min
            {settings.data.screenshot_randomize ? ', randomised' : ', fixed'} · kept{' '}
            {settings.data.screenshot_retention_days} days
          </span>
        )}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && <Loading />}

      {data && data.items.length === 0 && (
        <section className="card">
          <EmptyState
            icon={<IconCamera size={22} />}
            title="No screenshots on this day"
            body="Captures appear here once an enrolled agent runs during working hours. Try another date, or check that the employee's agent is installed and tracking."
          />
        </section>
      )}

      {data && data.items.length > 0 && (
        <>
          <p className="page-sub" style={{ marginTop: 0, marginBottom: 12 }}>
            {data.total} captures
          </p>
          <div className="shot-grid">
            {data.items.map((shot) => (
              <button className="shot-card" key={shot.id} onClick={() => setActive(shot)}>
                <AuthedImage className="shot-img" path={shot.thumb_url} alt={`Capture at ${clockTime(shot.captured_at, data.timezone)}`} />
                <div className="shot-meta">
                  <div className="shot-time">{clockTime(shot.captured_at, data.timezone)}</div>
                  <div className="shot-app" title={shot.window_title}>
                    {nameFor(shot.user_id)} · {shot.app_name || 'Unknown app'}
                  </div>
                  <div style={{ marginTop: 7, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <ProductivityBadge value={shot.productivity} />
                    {shot.monitor_count > 1 && (
                      <span className="badge">{shot.monitor_count} monitors</span>
                    )}
                    {shot.blurred && <span className="badge">Blurred</span>}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {active && (
        <div className="lightbox" onClick={() => setActive(null)} role="dialog" aria-modal="true">
          <AuthedImage path={active.full_url} alt={active.window_title || 'Screenshot'} />
          <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <span>
              <b>{nameFor(active.user_id)}</b> · {dateTime(active.captured_at, data?.timezone)}
            </span>
            <span>{active.app_name}</span>
            {active.url_domain && <span>{active.url_domain}</span>}
            <span>
              {active.width}×{active.height}
            </span>
            {canAdminister(user) && (
              <button
                className="btn btn-sm"
                onClick={async () => {
                  await api.del(`/admin/screenshots/${active.id}`)
                  setActive(null)
                  reload()
                }}
              >
                Delete
              </button>
            )}
            <button className="btn btn-sm" onClick={() => setActive(null)}>
              Close
            </button>
          </div>
          {active.window_title && (
            <div className="lightbox-bar" style={{ opacity: 0.75 }}>
              {active.window_title}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
