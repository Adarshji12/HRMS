import { IconBuilding, IconHome, IconGlobe } from './Icons'

/**
 * Where the employee says they are working, chosen at check-in.
 *
 * One component because two surfaces punch — the attendance page and the
 * employee home card — and a second copy of this list is a mode that silently
 * stops existing on one of them when somebody edits the other. Same reason
 * `requestFix` (the geolocation helper) is shared rather than written twice.
 *
 * The declaration matters beyond the label: it selects which geofence rule the
 * server applies (see `AttendanceSettings.geofence_for`). So the hints say what
 * each choice *means* rather than restating the name — somebody picking "On
 * duty" should know the note is the only record of which site they were at.
 */
export type WorkMode = 'office' | 'work_from_home' | 'on_duty'

export const WORK_MODES: Array<{
  value: WorkMode
  label: string
  hint: string
  icon: (p: { size?: number }) => JSX.Element
}> = [
  {
    value: 'office',
    label: 'Office',
    hint: 'At one of the company’s own locations.',
    icon: IconBuilding,
  },
  {
    value: 'work_from_home',
    label: 'Work from home',
    hint: 'Working remotely today.',
    icon: IconHome,
  },
  {
    value: 'on_duty',
    label: 'On duty',
    hint: 'Client site, a field visit, or travel. Say where in the note.',
    icon: IconGlobe,
  },
]

export const WORK_MODE_LABEL: Record<string, string> = Object.fromEntries(
  WORK_MODES.map((m) => [m.value, m.label]),
)

export default function WorkModePicker({
  value,
  onChange,
  disabled,
}: {
  value: WorkMode
  onChange: (mode: WorkMode) => void
  disabled?: boolean
}) {
  return (
    <fieldset className="wm-set" disabled={disabled}>
      {/* A legend rather than a floating label: these are radios, and the
          question they answer has to be readable by anything that lists the
          form's controls, not only by a sighted reader looking above them. */}
      <legend className="wm-legend">Where are you working?</legend>
      <div className="wm-choices">
        {WORK_MODES.map((mode) => (
          <label
            key={mode.value}
            className={`wm-choice${value === mode.value ? ' wm-choice-on' : ''}`}
          >
            {/* A real radio underneath, visually hidden. It keeps arrow-key
                navigation, the group semantics and the label association that a
                div with an onClick throws away. */}
            <input
              type="radio"
              name="work-mode"
              className="wm-radio"
              checked={value === mode.value}
              onChange={() => onChange(mode.value)}
            />
            <mode.icon size={17} />
            <span className="wm-choice-label">{mode.label}</span>
            <span className="wm-choice-hint">{mode.hint}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
