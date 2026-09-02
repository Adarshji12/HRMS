import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import type { OrgSettings, Rule } from '../lib/types'
import { Loading, ErrorNote, ProductivityBadge } from '../components/ui'
import Tabs from '../components/Tabs'

const INTERVAL_PRESETS = [
  { label: '1 min', value: 60 },
  { label: '5 min', value: 300 },
  { label: '10 min', value: 600 },
  { label: '15 min', value: 900 },
  { label: '30 min', value: 1800 },
]

type Section = 'screenshots' | 'activity' | 'notice' | 'rules'

/**
 * One setting: what it is on the left, the control on the right.
 *
 * The page used to lay these out in an auto-fit grid, which put three controls
 * of different heights side by side and left every row misaligned with the one
 * above it. A settings page is read down the left edge — "what can I change
 * here" — so the labels are the column that has to line up, not the inputs.
 */
function Row({
  title,
  desc,
  htmlFor,
  children,
}: {
  title: string
  desc?: ReactNode
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <label className="set-row-title" htmlFor={htmlFor}>
          {title}
        </label>
        {desc && <p className="set-row-desc">{desc}</p>}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  )
}

/** A boolean that reads as on or off at a glance, rather than as a tick box. */
function Toggle({
  id,
  checked,
  onChange,
  disabled,
  label,
}: {
  id: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <span className="toggle-wrap">
      <input
        id={id}
        type="checkbox"
        className="toggle"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-state">{checked ? 'On' : 'Off'}</span>
    </span>
  )
}

export default function Settings() {
  const { data, error, loading, reload } = useQuery<OrgSettings>('settings', () =>
    api.get<OrgSettings>('/admin/settings'),
  )
  const [form, setForm] = useState<OrgSettings | null>(null)
  const [tab, setTab] = useState<Section>('screenshots')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const rules = useQuery<Rule[]>('rules', () => api.get<Rule[]>('/admin/rules'))

  useEffect(() => {
    if (data) setForm(data)
  }, [data])

  // Which fields differ from what the server last gave us. Counting them rather
  // than tracking a boolean lets the save bar say how much is pending, which is
  // the difference between "something changed" and "you edited four things on a
  // tab you can no longer see".
  const changed = useMemo(() => {
    if (!data || !form) return [] as string[]
    return (Object.keys(data) as Array<keyof OrgSettings>).filter((k) => data[k] !== form[k])
  }, [data, form])

  if (error) return <ErrorNote>{error}</ErrorNote>
  if (loading || !form) return <Loading />

  function set<K extends keyof OrgSettings>(key: K, value: OrgSettings[K]) {
    setForm((current) => (current ? { ...current, [key]: value } : current))
    setSaved(false)
  }

  async function save(event?: FormEvent) {
    event?.preventDefault()
    if (!form) return
    setSaving(true)
    setSaveError(null)
    try {
      await api.put<OrgSettings>('/admin/settings', form)
      setSaved(true)
      reload()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const shots = form.screenshot_enabled
  const customInterval = !INTERVAL_PRESETS.some((p) => p.value === form.screenshot_interval_s)

  // Which tabs hold pending edits, so a change is never stranded behind a tab.
  const pendingIn = (keys: Array<keyof OrgSettings>) =>
    changed.some((k) => keys.includes(k as keyof OrgSettings))
  const screenshotKeys: Array<keyof OrgSettings> = [
    'screenshot_enabled', 'screenshot_interval_s', 'screenshot_randomize', 'screenshot_quality',
    'screenshot_max_width', 'screenshot_retention_days', 'blur_screenshots', 'capture_all_monitors',
  ]
  const activityKeys: Array<keyof OrgSettings> = [
    'idle_threshold_s', 'activity_retention_days', 'min_segment_s', 'sync_interval_s',
    'track_urls', 'track_window_titles', 'work_day_start', 'work_day_end', 'track_outside_hours',
  ]
  const noticeKeys: Array<keyof OrgSettings> = ['notice_required', 'notice_text']

  return (
    <div className={changed.length > 0 ? 'has-savebar' : undefined}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Tracking policy</h1>
          <p className="page-sub">
            Applies to every agent. Picked up on the next heartbeat, with no redeploy.
          </p>
        </div>
      </div>

      <Tabs
        label="Policy sections"
        items={[
          { id: 'screenshots', label: 'Screenshots', badge: pendingIn(screenshotKeys) ? '•' : undefined },
          { id: 'activity', label: 'Activity', badge: pendingIn(activityKeys) ? '•' : undefined },
          { id: 'notice', label: 'Employee notice', badge: pendingIn(noticeKeys) ? '•' : undefined },
          { id: 'rules', label: 'Productivity rules', badge: rules.data?.length },
        ]}
        value={tab}
        onChange={setTab}
      />

      {saveError && <div style={{ marginBottom: 14 }}><ErrorNote>{saveError}</ErrorNote></div>}

      {tab === 'screenshots' && (
        <form onSubmit={save}>
          {/* The single most consequential switch in the product. It used to be
              a tick box with a 12px grey note beside it; now it states what it
              is doing and governs everything under it. */}
          <section className={`card set-hero ${shots ? 'set-hero-on' : ''}`}>
            <div className="set-hero-text">
              <h2 className="set-hero-title">
                {shots ? 'Screens are being captured' : 'Screen capture is off'}
              </h2>
              <p className="set-hero-desc">
                {shots
                  ? `Roughly ${Math.max(1, Math.round(3600 / form.screenshot_interval_s))} captures an hour per person, kept for ${form.screenshot_retention_days} days.`
                  : 'No screenshots are taken or stored. Everything below is inactive.'}
              </p>
            </div>
            <Toggle
              id="shots"
              checked={shots}
              onChange={(v) => set('screenshot_enabled', v)}
              label="Capture periodic screenshots"
            />
          </section>

          <section className="card set-rows" aria-disabled={!shots}>
            <Row
              title="Interval"
              desc="How often a capture is taken from each machine."
            >
              <div className="preset-row">
                {INTERVAL_PRESETS.map((preset) => (
                  <button
                    type="button"
                    key={preset.value}
                    disabled={!shots}
                    className={`btn btn-sm${form.screenshot_interval_s === preset.value ? ' btn-primary' : ''}`}
                    onClick={() => set('screenshot_interval_s', preset.value)}
                  >
                    {preset.label}
                  </button>
                ))}
                <input
                  type="number"
                  min={30}
                  max={86400}
                  step={30}
                  disabled={!shots}
                  aria-label="Custom interval in seconds"
                  value={form.screenshot_interval_s}
                  onChange={(e) => set('screenshot_interval_s', Number(e.target.value))}
                  className={`preset-custom${customInterval ? ' preset-custom-on' : ''}`}
                />
                <span className="set-unit">sec</span>
              </div>
            </Row>

            <Row
              title="Randomise within the interval"
              desc="Same number of captures an hour, but the moment is unpredictable — a fixed cadence is trivial to work around."
              htmlFor="rand"
            >
              <Toggle
                id="rand"
                checked={form.screenshot_randomize}
                disabled={!shots}
                onChange={(v) => set('screenshot_randomize', v)}
                label="Randomise within each interval"
              />
            </Row>

            <Row title="Quality" desc="JPEG quality, 20–95. Lower saves bandwidth and storage.">
              <input
                type="number"
                min={20}
                max={95}
                disabled={!shots}
                value={form.screenshot_quality}
                onChange={(e) => set('screenshot_quality', Number(e.target.value))}
                className="set-input-sm"
              />
            </Row>

            <Row title="Maximum width" desc="Captures are downscaled to this before storage.">
              <span className="set-inline">
                <input
                  type="number"
                  min={320}
                  max={3840}
                  step={80}
                  disabled={!shots}
                  value={form.screenshot_max_width}
                  onChange={(e) => set('screenshot_max_width', Number(e.target.value))}
                  className="set-input-sm"
                />
                <span className="set-unit">px</span>
              </span>
            </Row>

            <Row
              title="Retention"
              desc="Enforced by the purge job, which deletes the image files too — not just the rows."
            >
              <span className="set-inline">
                <input
                  type="number"
                  min={1}
                  max={3650}
                  disabled={!shots}
                  value={form.screenshot_retention_days}
                  onChange={(e) => set('screenshot_retention_days', Number(e.target.value))}
                  className="set-input-sm"
                />
                <span className="set-unit">days</span>
              </span>
            </Row>

            <Row
              title="Blur captures"
              desc="Obscures text while keeping the layout recognisable — the lower-intrusion mode some works councils require."
              htmlFor="blur"
            >
              <Toggle
                id="blur"
                checked={form.blur_screenshots}
                disabled={!shots}
                onChange={(v) => set('blur_screenshots', v)}
                label="Blur captures"
              />
            </Row>

            <Row
              title="Capture all monitors"
              desc="Off, only the primary display is captured."
              htmlFor="monitors"
            >
              <Toggle
                id="monitors"
                checked={form.capture_all_monitors}
                disabled={!shots}
                onChange={(v) => set('capture_all_monitors', v)}
                label="Capture all monitors"
              />
            </Row>
          </section>
        </form>
      )}

      {tab === 'activity' && (
        <form onSubmit={save}>
          <section className="card set-rows">
            <Row
              title="Idle threshold"
              desc="Time with no keyboard or mouse input before the seconds stop counting as work."
            >
              <span className="set-inline">
                <input
                  type="number"
                  min={30}
                  max={3600}
                  step={30}
                  value={form.idle_threshold_s}
                  onChange={(e) => set('idle_threshold_s', Number(e.target.value))}
                  className="set-input-sm"
                />
                <span className="set-unit">sec</span>
              </span>
            </Row>

            <Row
              title="Minimum segment"
              desc="Shorter focus changes are discarded as alt-tab noise rather than stored."
            >
              <span className="set-inline">
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={form.min_segment_s}
                  onChange={(e) => set('min_segment_s', Number(e.target.value))}
                  className="set-input-sm"
                />
                <span className="set-unit">sec</span>
              </span>
            </Row>

            <Row title="Sync interval" desc="How often each agent uploads what it has spooled.">
              <span className="set-inline">
                <input
                  type="number"
                  min={10}
                  max={3600}
                  value={form.sync_interval_s}
                  onChange={(e) => set('sync_interval_s', Number(e.target.value))}
                  className="set-input-sm"
                />
                <span className="set-unit">sec</span>
              </span>
            </Row>

            <Row title="Activity retention" desc="How long segments are kept before the purge job removes them.">
              <span className="set-inline">
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={form.activity_retention_days}
                  onChange={(e) => set('activity_retention_days', Number(e.target.value))}
                  className="set-input-sm"
                />
                <span className="set-unit">days</span>
              </span>
            </Row>

            <Row
              title="Record visited websites"
              desc="Turning this off drops the data at ingest, not just in the UI."
              htmlFor="urls"
            >
              <Toggle
                id="urls"
                checked={form.track_urls}
                onChange={(v) => set('track_urls', v)}
                label="Record visited websites"
              />
            </Row>

            <Row
              title="Record window titles"
              desc="Also dropped at ingest when off. Titles are what makes an app row readable, and also the most revealing part of it."
              htmlFor="titles"
            >
              <Toggle
                id="titles"
                checked={form.track_window_titles}
                onChange={(v) => set('track_window_titles', v)}
                label="Record window titles"
              />
            </Row>

            <Row title="Working hours" desc="The window agents treat as the working day.">
              <span className="set-inline">
                <input
                  type="time"
                  value={form.work_day_start}
                  onChange={(e) => set('work_day_start', e.target.value)}
                  aria-label="Working day starts"
                />
                <span className="set-unit">to</span>
                <input
                  type="time"
                  value={form.work_day_end}
                  onChange={(e) => set('work_day_end', e.target.value)}
                  aria-label="Working day ends"
                />
              </span>
            </Row>

            <Row
              title="Track outside working hours"
              desc="Off by default. Monitoring personal time is the fastest way to lose a works-council approval."
              htmlFor="outside"
            >
              <Toggle
                id="outside"
                checked={form.track_outside_hours}
                onChange={(v) => set('track_outside_hours', v)}
                label="Also track outside working hours"
              />
            </Row>
          </section>
        </form>
      )}

      {tab === 'notice' && (
        <form onSubmit={save}>
          <section className="card set-rows">
            <Row
              title="Require acknowledgement"
              desc="The agent will not enrol until the employee accepts. The acceptance timestamp is stored against their record."
              htmlFor="notice"
            >
              <Toggle
                id="notice"
                checked={form.notice_required}
                onChange={(v) => set('notice_required', v)}
                label="Require employees to acknowledge the notice"
              />
            </Row>
          </section>

          <section className="card" style={{ marginTop: 14 }}>
            <div className="card-head">
              <h2 className="card-title">Notice text</h2>
              <span className="card-note">{form.notice_text.length} characters</span>
            </div>
            <textarea
              className="set-textarea"
              value={form.notice_text}
              onChange={(e) => set('notice_text', e.target.value)}
              rows={7}
              aria-label="Employee notice text"
            />
            <p className="set-row-desc" style={{ marginTop: 10 }}>
              Shown by the agent at enrolment and from its tray menu at any time. This is the text
              an employee is agreeing to, so it should describe what is actually collected — the
              settings on the other tabs decide that.
            </p>
          </section>
        </form>
      )}

      {tab === 'rules' && <RulesSection query={rules} />}

      {/* Sticky rather than a button somewhere in the flow. The old one sat
          after ~800px of form, below the fold on every screen, and gave no sign
          that anything was unsaved — you could switch tabs or leave the page
          and lose the lot silently. */}
      {changed.length > 0 && (
        <div className="savebar" role="region" aria-label="Unsaved changes">
          <span className="savebar-text">
            <b>{changed.length}</b> unsaved change{changed.length === 1 ? '' : 's'}
          </span>
          <button
            className="btn"
            type="button"
            disabled={saving}
            onClick={() => {
              setForm(data ?? null)
              setSaveError(null)
            }}
          >
            Discard
          </button>
          <button className="btn btn-primary" type="button" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save policy'}
          </button>
        </div>
      )}

      {saved && changed.length === 0 && (
        <div className="notice notice-ok" style={{ marginTop: 14 }} role="status">
          Policy saved. Agents apply it on their next heartbeat.
        </div>
      )}
    </div>
  )
}

function RulesSection({ query }: { query: ReturnType<typeof useQuery<Rule[]>> }) {
  const { data, error, loading, reload } = query
  const [draft, setDraft] = useState({
    match_type: 'domain',
    pattern: '',
    productivity: 'unproductive',
  })
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')
  const [kind, setKind] = useState('all')

  async function add(event: FormEvent) {
    event.preventDefault()
    if (!draft.pattern.trim()) return
    setBusy(true)
    try {
      await api.post('/admin/rules', { ...draft, pattern: draft.pattern.trim() })
      setDraft({ ...draft, pattern: '' })
      reload()
    } finally {
      setBusy(false)
    }
  }

  const needle = filter.trim().toLowerCase()
  const shown = (data ?? []).filter(
    (rule) =>
      (kind === 'all' || rule.match_type === kind) &&
      (!needle ||
        rule.pattern.toLowerCase().includes(needle) ||
        (rule.label ?? '').toLowerCase().includes(needle)),
  )

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Add a rule</h2>
          {/* This list saves on the spot, unlike the tabs beside it. Two save
              models on one page is confusing unless the page says so. */}
          <span className="card-note">Rules apply immediately — no save needed</span>
        </div>

        <form onSubmit={add} className="filter-row">
          <select
            value={draft.match_type}
            onChange={(e) => setDraft({ ...draft, match_type: e.target.value })}
          >
            <option value="domain">Website domain</option>
            <option value="app">Application executable</option>
            <option value="title">Window title contains</option>
          </select>
          <input
            value={draft.pattern}
            onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
            placeholder={draft.match_type === 'app' ? 'slack.exe' : 'youtube.com'}
            style={{ minWidth: 220 }}
            aria-label="Pattern"
          />
          <select
            value={draft.productivity}
            onChange={(e) => setDraft({ ...draft, productivity: e.target.value })}
          >
            <option value="productive">Productive</option>
            <option value="neutral">Neutral</option>
            <option value="unproductive">Unproductive</option>
          </select>
          <button className="btn btn-primary btn-sm" disabled={busy}>
            Add rule
          </button>
        </form>

        <p className="set-row-desc" style={{ marginTop: 12 }}>
          The most specific match wins, so <code>mail.google.com</code> outranks{' '}
          <code>google.com</code>. Domain rules also match subdomains. Classification is stored at
          ingest, so use <b>Reclassify history</b> to apply a change to data you already have.
        </p>
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <div className="card-head">
          <h2 className="card-title">
            Rules{' '}
            <span className="card-note">
              {shown.length === (data?.length ?? 0)
                ? `${data?.length ?? 0}`
                : `${shown.length} of ${data?.length ?? 0}`}
            </span>
          </h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-sm"
              onClick={async () => {
                await api.post('/admin/rules/restore-defaults')
                reload()
              }}
            >
              Restore defaults
            </button>
            <button
              className="btn btn-sm"
              onClick={async () => {
                await api.post('/admin/reclassify?days=30')
                reload()
              }}
              title="Re-apply the current rules to the last 30 days"
            >
              Reclassify history
            </button>
          </div>
        </div>

        {/* Thirty-odd rules arrived as one unbroken table. Finding whether
            youtube.com was already classified meant reading all of them. */}
        <div className="filter-row" style={{ marginBottom: 12 }}>
          <input
            type="search"
            placeholder="Find a pattern…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ minWidth: 240 }}
          />
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Rule type">
            <option value="all">All types</option>
            <option value="domain">Domains</option>
            <option value="app">Applications</option>
            <option value="title">Window titles</option>
          </select>
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}
        {loading && <Loading />}

        {data && shown.length === 0 && <p className="empty">No rule matches that.</p>}

        {data && shown.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Pattern</th>
                  <th>Classification</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((rule) => (
                  <tr key={rule.id}>
                    <td style={{ color: 'var(--text-secondary)' }}>{rule.match_type}</td>
                    <td>
                      <span className="key-chip">{rule.pattern}</span>
                      {rule.label && (
                        <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontSize: 12 }}>
                          {rule.label}
                        </span>
                      )}
                    </td>
                    <td>
                      <ProductivityBadge value={rule.productivity} />
                    </td>
                    <td className="num">
                      <button
                        className="btn btn-sm"
                        onClick={async () => {
                          await api.del(`/admin/rules/${rule.id}`)
                          reload()
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}
