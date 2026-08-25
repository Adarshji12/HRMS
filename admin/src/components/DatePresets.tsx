import { daysAgoISO, todayISO } from '../lib/format'

export type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'custom'

export interface Range {
  start: string
  end: string
  preset: Preset
}

function startOfWeek(): string {
  const d = new Date()
  // Monday-based, matching the timesheet period logic. Changing one without
  // the other would make "this week" mean two different things in one product.
  const offset = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - offset)
  return d.toISOString().slice(0, 10)
}

function startOfMonth(): string {
  const d = new Date()
  d.setDate(1)
  return d.toISOString().slice(0, 10)
}

export function resolvePreset(preset: Preset, current: Range): Range {
  switch (preset) {
    case 'today':
      return { start: todayISO(), end: todayISO(), preset }
    case 'yesterday':
      return { start: daysAgoISO(1), end: daysAgoISO(1), preset }
    case 'week':
      return { start: startOfWeek(), end: todayISO(), preset }
    case 'month':
      return { start: startOfMonth(), end: todayISO(), preset }
    default:
      return { ...current, preset: 'custom' }
  }
}

const PRESETS: Array<{ id: Preset; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
]

/**
 * Shared date control.
 *
 * `singleDay` collapses to one input for screens that genuinely only show one
 * day (a timeline cannot span a month usefully). The presets stay, because
 * "yesterday" is by far the most common thing anyone wants and typing a date
 * to get it is a small daily tax.
 */
export function DatePresets({
  value,
  onChange,
  singleDay = false,
}: {
  value: Range
  onChange: (range: Range) => void
  singleDay?: boolean
}) {
  const presets = singleDay ? PRESETS.slice(0, 2) : PRESETS

  return (
    <>
      <div className="ts-toggle" role="group" aria-label="Date range">
        {presets.map((preset) => (
          <button
            key={preset.id}
            className={`ts-toggle-btn ${value.preset === preset.id ? 'ts-toggle-on' : ''}`}
            onClick={() => onChange(resolvePreset(preset.id, value))}
            aria-pressed={value.preset === preset.id}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {singleDay ? (
        <label className="field">
          Date
          <input
            type="date"
            value={value.end}
            max={todayISO()}
            onChange={(e) => onChange({ start: e.target.value, end: e.target.value, preset: 'custom' })}
          />
        </label>
      ) : (
        <>
          <label className="field">
            From
            <input
              type="date"
              value={value.start}
              max={value.end}
              onChange={(e) => onChange({ ...value, start: e.target.value, preset: 'custom' })}
            />
          </label>
          <label className="field">
            To
            <input
              type="date"
              value={value.end}
              max={todayISO()}
              onChange={(e) => onChange({ ...value, end: e.target.value, preset: 'custom' })}
            />
          </label>
        </>
      )}
    </>
  )
}
