import { Fragment, useState, type FormEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import '../../../styles/attendance.css'
import HolidayMaster from '../../masters/HolidayMaster'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { canAdminister, useAuth } from '../../../lib/auth'
import type { User } from '../../../lib/types'
import { Empty, EmptyState, ErrorNote, Loading } from '../../../components/ui'
import { IconCalendar, IconCheck, IconClock, IconEdit, IconGauge, IconPin, IconPlus, IconTrash, IconUser } from '../../../components/Icons'
import { Dialog, Field } from '../../crm/parts'
import {
  addDays,
  hm,
  orgToday,
  typedError,
  type AttendanceSettingsPayload,
  type Enforcement,
  type OfficeLocation,
  type TypedFailure,
} from './MyAttendance'
import {
  ColumnSettings, FieldSettings, useColumns, useFieldModes,
  type ColumnDef, type FieldDef, type FieldSection,
} from '../../../components/ViewSettings'

/* ------------------------------------------------- view settings (tables, forms) -- */

const star = (on: boolean) => (on ? <span className="lf-req"> *</span> : null)

type LocationColumn = ColumnDef & { td: (row: OfficeLocation) => ReactNode; className?: string; thClass?: string }
const LOCATION_COLUMNS: LocationColumn[] = [
  { key: 'name', label: 'Name', locked: true, td: (row) => (
    <>
      <b>{row.name}</b>
      {row.address && <div className="muted-sm">{row.address}</div>}
    </>
  ) },
  { key: 'coords', label: 'Coordinates', className: 'muted-sm', td: (row) => (row.lat === null || row.lng === null ? 'Not mapped' : `${row.lat.toFixed(5)}, ${row.lng.toFixed(5)}`) },
  { key: 'radius', label: 'Radius', className: 'num', thClass: 'num', td: (row) => `${row.radius_m} m` },
  { key: 'state', label: 'State', td: (row) => (
    <span className={`badge ${row.is_active ? 'badge-ok' : ''}`}>{row.is_active ? 'Active' : 'Inactive'}</span>
  ) },
  { key: 'address', label: 'Address', initial: false, className: 'muted-sm', td: (row) => row.address || '—' },
  { key: 'added', label: 'Added on', initial: false, td: (row) => (row.created_at ? row.created_at.slice(0, 10) : '—') },
]

const LOCATION_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Name', section: 'location', fixed: true },
  { key: 'address', label: 'Address', section: 'location' },
  { key: 'lat', label: 'Latitude', section: 'location', fixed: true },
  { key: 'lng', label: 'Longitude', section: 'location', fixed: true },
  { key: 'radius_m', label: 'Radius (metres)', section: 'location', initial: 'mandatory' },
  { key: 'is_active', label: 'Active', section: 'location', optionalOnly: true },
]
const LOCATION_SECTIONS: FieldSection[] = [{ id: 'location', label: 'Office location' }]

type ShiftColumn = ColumnDef & { td: (row: Shift) => ReactNode; className?: string; thClass?: string }
const SHIFT_COLUMNS: ShiftColumn[] = [
  { key: 'name', label: 'Shift', locked: true, td: (row) => (
    <>
      <b>{row.name}</b>
      {row.is_night_shift && <span className="badge" style={{ marginLeft: 8 }}>night</span>}
    </>
  ) },
  { key: 'hours', label: 'Hours', td: (row) => <>{row.start_time} – {row.end_time}</> },
  { key: 'expected', label: 'Expected', className: 'num', thClass: 'num', td: (row) => hm(row.expected_minutes) },
  { key: 'grace', label: 'Grace', className: 'num', thClass: 'num', td: (row) => `${row.grace_minutes}m` },
  { key: 'half', label: 'Half day under', className: 'num', thClass: 'num', td: (row) => hm(row.half_day_threshold_minutes) },
  { key: 'assigned', label: 'On it now', className: 'num', thClass: 'num', td: (row) => row.assigned_count },
  { key: 'state', label: 'State', td: (row) => (
    <span className={`badge ${row.is_active ? 'badge-ok' : ''}`}>{row.is_active ? 'Active' : 'Inactive'}</span>
  ) },
  { key: 'night', label: 'Night shift', initial: false, td: (row) => (row.is_night_shift ? 'Yes' : 'No') },
]

const SHIFT_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Name', section: 'shift', fixed: true },
  { key: 'start_time', label: 'Starts', section: 'shift', initial: 'mandatory' },
  { key: 'end_time', label: 'Ends', section: 'shift', initial: 'mandatory' },
  { key: 'grace_minutes', label: 'Grace (minutes)', section: 'shift', initial: 'mandatory' },
  { key: 'half_day_threshold_hours', label: 'Half-day threshold (hours)', section: 'shift', initial: 'mandatory' },
  { key: 'is_night_shift', label: 'Night shift', section: 'shift', optionalOnly: true },
  { key: 'is_active', label: 'Active', section: 'shift', optionalOnly: true },
]
const SHIFT_SECTIONS: FieldSection[] = [{ id: 'shift', label: 'Shift' }]

type RotaColumn = ColumnDef & { td: (row: ShiftAssignment) => ReactNode; className?: string; thClass?: string }
const ROTA_COLUMNS: RotaColumn[] = [
  { key: 'employee', label: 'Employee', locked: true, td: (row) => row.user_name ?? '—' },
  { key: 'shift', label: 'Shift', td: (row) => (
    <>
      {row.shift_name ?? '—'}
      {row.shift_start_time && (
        <div className="muted-sm">{row.shift_start_time} – {row.shift_end_time}</div>
      )}
    </>
  ) },
  { key: 'from', label: 'From', td: (row) => row.effective_from },
  { key: 'to', label: 'To', td: (row) => row.effective_to ?? <span className="muted-sm">open-ended</span> },
  { key: 'state', label: 'State', td: (row) => (
    <span className={`badge ${row.is_current ? 'badge-ok' : ''}`}>{row.is_current ? 'Current' : 'Closed'}</span>
  ) },
]

const ROTA_FIELDS: FieldDef[] = [
  { key: 'user_id', label: 'Employee', section: 'assignment', fixed: true },
  { key: 'shift_id', label: 'Shift', section: 'assignment', fixed: true },
  { key: 'effective_from', label: 'Effective from', section: 'assignment', fixed: true },
  { key: 'effective_to', label: 'Effective to', section: 'assignment' },
]
const ROTA_SECTIONS: FieldSection[] = [{ id: 'assignment', label: 'Assignment' }]

/* ------------------------------------------------------------------ types -- */

/** `ShiftOut`. Times are "HH:MM"; every duration is integer minutes (D-012). */
interface Shift {
  id: string
  name: string
  start_time: string
  end_time: string
  grace_minutes: number
  half_day_threshold_minutes: number
  /** Derived server-side from the minutes column — display only. */
  half_day_threshold_hours: number
  is_night_shift: boolean
  is_active: boolean
  expected_minutes: number
  assigned_count: number
}

/** `ShiftAssignmentOut`. Effective-dated (D-011): rows are closed, not edited. */
interface ShiftAssignment {
  id: string
  user_id: string
  shift_id: string
  effective_from: string
  effective_to: string | null
  user_name: string | null
  shift_name: string | null
  shift_start_time: string | null
  shift_end_time: string | null
  is_current: boolean
}

type ModeField = 'geofence_office' | 'geofence_work_from_home' | 'geofence_on_duty'

const ENFORCEMENT_LABEL: Record<string, string> = {
  off: 'Off',
  flag_only: 'Flag only',
  required: 'Required',
}

/* Named for the mode, not the column. The hint says what the mode *means* to
   the employee choosing it, because that is what an administrator is actually
   deciding about when they set its rule. */
const MODE_ROWS: Array<{ field: ModeField; label: string; hint: string }> = [
  {
    field: 'geofence_office',
    label: 'Office',
    hint: 'At one of your own locations — the mode the fence was designed for.',
  },
  {
    field: 'geofence_work_from_home',
    label: 'Work from home',
    hint: 'Usually Off. A home address is not an office and never will be inside one.',
  },
  {
    field: 'geofence_on_duty',
    label: 'On duty',
    hint: 'Client site, field visit or travel. Flag only keeps the distance on record without refusing the punch.',
  },
]

const ENFORCEMENT_COPY: Array<{ value: Enforcement; title: string; desc: string }> = [
  {
    value: 'off',
    title: 'Off',
    desc:
      'No distance is measured at all. Punches carry no location and no office is compared against — the right setting for a fully remote company.',
  },
  {
    value: 'flag_only',
    title: 'Flag only',
    desc:
      'Measure and record, but never refuse. A punch from outside an office is accepted and marked unverified so a manager can ask about it. This is the default.',
  },
  {
    value: 'required',
    title: 'Required',
    desc:
      'Refuse any punch without a location, or from outside every office area. Employees who deny the browser prompt cannot punch at all and will need a regularisation.',
  },
]

/* ------------------------------------------------------------------- page -- */

type AttendanceTab = 'methods' | 'shift' | 'holiday' | 'overtime'

const ATTENDANCE_TABS: Array<{ key: AttendanceTab; label: string; icon: ReactNode }> = [
  { key: 'methods', label: 'Methods', icon: <IconPin size={15} /> },
  { key: 'shift', label: 'Shift', icon: <IconClock size={15} /> },
  { key: 'holiday', label: 'Holiday', icon: <IconCalendar size={15} /> },
  { key: 'overtime', label: 'Overtime', icon: <IconGauge size={15} /> },
]

/** `embedded` is how HR Settings shows it: under its own tabs, so the page heading is left out. */
export default function AttendanceSettings({ embedded = false }: { embedded?: boolean }) {
  const { user, organization } = useAuth()
  const [params, setParams] = useSearchParams()
  const asked = params.get('sub') as AttendanceTab | null
  const sub: AttendanceTab = ATTENDANCE_TABS.some((t) => t.key === asked) ? asked! : 'methods'
  const go = (next: AttendanceTab) => {
    const keep: Record<string, string> = {}
    params.forEach((value, key) => { keep[key] = value })
    setParams({ ...keep, sub: next }, { replace: true })
  }
  const isAdmin = canAdminister(user)
  const today = orgToday(organization?.timezone)

  const settingsQ = useQuery<AttendanceSettingsPayload>('att-settings-admin', () =>
    api.get<AttendanceSettingsPayload>('/attendance/settings'),
  )
  const locationsQ = useQuery<OfficeLocation[]>('att-locations-admin', () =>
    api.get<OfficeLocation[]>('/attendance/locations'),
  )
  const shiftsQ = useQuery<Shift[]>('att-shifts', () => api.get<Shift[]>('/attendance/shifts'))
  const rotaQ = useQuery<ShiftAssignment[]>('att-rota', () =>
    api.get<ShiftAssignment[]>('/attendance/shift-assignments'),
  )
  const employeesQ = useQuery<User[]>('att-employees', () => api.get<User[]>('/admin/employees'), {
    enabled: isAdmin,
  })

  /* The server refuses every write below for a non-admin. Hiding the whole
     surface rather than showing controls that always 403 — a visible button
     that cannot work is a bug, not security. */
  if (!isAdmin) {
    return (
      <EmptyState
        title="Attendance settings are for administrators"
        body="Shifts, office locations and the geofence policy are set by an owner or administrator."
      />
    )
  }

  const settings = settingsQ.data
  const locations = locationsQ.data ?? []
  const shifts = shiftsQ.data ?? []

  return (
    <div>
      {!embedded && (
        <div className="page-head">
          <div>
            <h1 className="page-title">Attendance settings</h1>
            <p className="page-sub">
              Where punching counts from, which shifts exist, and who is on them.
            </p>
          </div>
        </div>
      )}

      <nav className="hs-tabs hs-subtabs" role="tablist" aria-label="Attendance settings">
        {ATTENDANCE_TABS.map((t) => (
          <button key={t.key} role="tab" type="button" aria-selected={sub === t.key}
                  className={`hs-tab${sub === t.key ? ' is-on' : ''}`} onClick={() => go(t.key)}>
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>

      {sub === 'methods' && (
        <MethodsTab
          settings={settings}
          loading={settingsQ.loading}
          error={settingsQ.error}
          locations={locations}
          onSaved={() => { settingsQ.reload(); locationsQ.reload() }}
        />
      )}

      {sub === 'shift' && (
        <>
        <Shifts
          shifts={shifts}
          loading={shiftsQ.loading}
          error={shiftsQ.error}
          onChanged={() => {
            shiftsQ.reload()
            rotaQ.reload()
          }}
        />

        <Rota
          rota={rotaQ.data}
          loading={rotaQ.loading}
          error={rotaQ.error}
          shifts={shifts}
          employees={employeesQ.data ?? []}
          today={today}
          onChanged={() => {
            rotaQ.reload()
            shiftsQ.reload()
          }}
        />

        <Recompute today={today} />
        </>
      )}

      {sub === 'holiday' && <HolidayMaster />}

      {sub === 'overtime' && (
        <OvertimePolicy
          settings={settings}
          loading={settingsQ.loading}
          error={settingsQ.error}
          onSaved={() => settingsQ.reload()}
        />
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- methods -- */

type MethodKey = 'manual' | 'face' | 'biometric'

interface AttendanceDevice {
  id: string
  kind: 'face' | 'biometric'
  name: string
  device_code: string | null
  location_id: string | null
  location_name: string | null
  branch_id: string | null
  branch_name: string | null
  is_active: boolean
  location_required: boolean
  lat: number | null
  lng: number | null
  radius_m: number | null
  ip_required: boolean
  allowed_ips: string | null
  cooldown_s: number
  allowed_from_min: number
  allowed_until_min: number
}

/** How people punch: Manual (the button on the dashboard or in the app), and the face and
 *  biometric terminals the company owns. Manual is real. The two device methods keep a
 *  register of the hardware; receiving their punches is not built yet, and the panels say so.
 *  The geofence policy and office list (GeofencePolicy, Locations below) are not shown here: the
 *  offices are kept in Master → Location. */
function MethodsTab({
  settings, loading, error, locations, onSaved,
}: {
  settings: AttendanceSettingsPayload | undefined
  loading: boolean
  error: string | null
  locations: OfficeLocation[]
  onSaved: () => void
}) {
  const [method, setMethod] = useState<MethodKey>('manual')
  const action = useAction(onSaved)
  const [draft, setDraft] = useState<{ manual: boolean; web: boolean; mobile: boolean; face: boolean; biometric: boolean } | null>(null)
  if (loading && !settings) return <Loading />
  if (error) return <ErrorNote>{error}</ErrorNote>
  if (!settings) return null

  // `?? default`: a page opened against an API that has not caught up still shows the real defaults.
  const saved = {
    manual: settings.manual_enabled ?? true, web: settings.manual_web_enabled ?? true, mobile: settings.manual_mobile_enabled ?? true,
    face: settings.face_enabled ?? false, biometric: settings.biometric_enabled ?? false,
  }
  const form = draft ?? saved
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved)
  const set = (patch: Partial<typeof form>) => setDraft({ ...form, ...patch })
  const nothingOn = !form.manual && !form.face && !form.biometric

  const tabs: Array<{ key: MethodKey; label: string }> = [
    { key: 'manual', label: 'Manual Attendance' },
    { key: 'face', label: 'Face Attendance Device' },
    { key: 'biometric', label: 'Biometric Attendance' },
  ]

  return (
    <>
      <nav className="hs-methodtabs" role="tablist" aria-label="Attendance methods">
        {tabs.map((t, index) => (
          <button key={t.key} role="tab" type="button" aria-selected={method === t.key}
                  className={`hs-methodtab${method === t.key ? ' is-on' : ''}`} onClick={() => setMethod(t.key)}>
            <span className="hs-step">{index + 1}</span>
            {t.label}
          </button>
        ))}
      </nav>

      <Feedback failure={action.failure} notice={action.notice} />

      {method === 'manual' && (
        <>
          <MethodCard
            icon={<IconUser size={18} />}
            title="Manual Attendance"
            body="The employee presses Check In and Check Out themselves, on the dashboard or in the app."
            enabled={form.manual}
            onEnabled={(on) => set({ manual: on })}
          >
            <label className="hs-method-row">
              <input type="checkbox" checked={form.web} disabled={!form.manual} onChange={(e) => set({ web: e.target.checked })} />
              <span>
                <b>Check In / Check Out on the web dashboard</b>
                <span className="muted-sm">The button at the top of the employee’s dashboard and the Attendance page.</span>
              </span>
            </label>
            <label className="hs-method-row">
              <input type="checkbox" checked={form.mobile} disabled={!form.manual} onChange={(e) => set({ mobile: e.target.checked })} />
              <span>
                <b>Check In / Check Out in the mobile app</b>
                <span className="muted-sm">The same day, the same register — a punch from either shows up in both.</span>
              </span>
            </label>
            <p className="hs-method-note">
              The first punch of the day is the <b>Check In</b> and the last is the <b>Check Out</b>; anything between them is
              recorded and shown, but the working hours are measured from the first to the last. Nothing here proves <i>where</i>{' '}
              somebody was — a signed-in session is all a button can prove — so pair it with the Geofence card if being on site matters.
            </p>
          </MethodCard>
        </>
      )}

      {method === 'face' && (
        <MethodCard
          icon={<IconCheck size={18} />}
          title="Face Attendance Device"
          body="A tablet at the entrance that recognises faces with no code typed."
          enabled={form.face}
          onEnabled={(on) => set({ face: on })}
        >
          <DeviceRegister kind="face" locations={locations} />
        </MethodCard>
      )}

      {method === 'biometric' && (
        <MethodCard
          icon={<IconCheck size={18} />}
          title="Biometric Attendance"
          body="A fingerprint terminal at the entrance that records the punch."
          enabled={form.biometric}
          onEnabled={(on) => set({ biometric: on })}
        >
          <DeviceRegister kind="biometric" locations={locations} />
        </MethodCard>
      )}

      <div className="hs-methods-foot">
        <span className="muted-sm">
          {dirty ? 'Unsaved changes' : 'Everything saved'}
          {nothingOn && ' — no method is on, so nobody can be marked present'}
        </span>
        <button
          className="btn btn-primary"
          disabled={!dirty || action.busy}
          onClick={() =>
            void action
              .run(
                () => api.put('/attendance/settings', {
                  manual_enabled: form.manual, manual_web_enabled: form.web, manual_mobile_enabled: form.mobile,
                  face_enabled: form.face, biometric_enabled: form.biometric,
                }),
                'Attendance methods saved.',
              )
              .then((ok) => { if (ok) setDraft(null) })
          }
        >
          {action.busy ? 'Saving…' : 'Save methods'}
        </button>
      </div>
    </>
  )
}

function MethodCard({
  icon, title, body, enabled, onEnabled, children,
}: {
  icon: ReactNode
  title: string
  body: string
  enabled: boolean
  onEnabled: (on: boolean) => void
  children: ReactNode
}) {
  return (
    <section className="card hs-method" style={{ marginBottom: 14 }}>
      <div className="hs-method-head">
        <span className="hs-method-icon" aria-hidden>{icon}</span>
        <div className="hs-method-titles">
          <h2>{title}</h2>
          <p>{body}</p>
        </div>
        <label className="hs-method-enabled">
          <input type="checkbox" checked={enabled} onChange={(e) => onEnabled(e.target.checked)} />
          Enabled
        </label>
      </div>
      <div className="hs-method-body">{children}</div>
    </section>
  )
}

/** The terminals a company owns. A register only: it does not receive punches yet. */
function DeviceRegister({ kind, locations }: { kind: 'face' | 'biometric'; locations: OfficeLocation[] }) {
  const devicesQ = useQuery<AttendanceDevice[]>('att-devices', () => api.get<AttendanceDevice[]>('/attendance/devices'))
  const [editing, setEditing] = useState<AttendanceDevice | 'new' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const rows = (devicesQ.data ?? []).filter((d) => d.kind === kind)

  async function remove(device: AttendanceDevice) {
    if (!window.confirm(`Remove “${device.name}”?`)) return
    setFailure(null)
    try {
      await api.del(`/attendance/devices/${device.id}`)
      devicesQ.reload()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'That device could not be removed')
    }
  }

  const checks = (d: AttendanceDevice) => [d.location_required && 'Location', d.ip_required && 'IP address'].filter(Boolean).join(' + ') || 'None'

  return (
    <div>
      <p className="hs-method-note">
        {kind === 'face' ? (
          <>
            A face device is a tablet at the entrance with <i>Recognise faces</i> switched on — employees walk up and are recognised
            with no code typed. There is no separate employee sync: matching happens live against whoever is enrolled, so a person
            enrolled this morning works at every device this afternoon.
          </>
        ) : (
          <>
            A biometric device is a fingerprint terminal at the entrance — employees touch it and are recognised with no code typed.
          </>
        )}{' '}
        Punches from devices are <b>not received yet</b>: registering one here records what it is allowed to do, ready for when
        syncing is connected.
      </p>
      {failure && <ErrorNote>{failure}</ErrorNote>}
      <div className="hs-device-head">
        <span className="muted-sm">
          {rows.length === 0 ? 'None set up yet.' : `${rows.length} set up.`}
        </span>
        <button className="btn btn-primary" onClick={() => setEditing('new')}><IconPlus size={14} /> Add</button>
      </div>
      {devicesQ.loading && !devicesQ.data ? <Loading /> : rows.length === 0 ? (
        <div className="hs-device-empty">
          <b>Nothing set up for this method yet</b>
          <span className="muted-sm">Add one to record the device, who it is for and what it checks.</span>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Branch</th><th>Checks</th><th>State</th><th style={{ textAlign: 'right' }}>Actions</th></tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td><b>{d.name}</b></td>
                  <td className="muted-sm">{d.branch_name ?? 'All branches'}</td>
                  <td className="muted-sm">{checks(d)}</td>
                  <td>{d.is_active ? 'Active' : 'Inactive'}</td>
                  <td>
                    <div className="crm-row-actions" style={{ justifyContent: 'flex-end' }}>
                      <button className="crm-icon-btn" onClick={() => setEditing(d)} aria-label={`Edit ${d.name}`} title="Edit"><IconEdit size={16} /></button>
                      <button className="crm-icon-btn dm-delete" onClick={() => remove(d)} aria-label={`Remove ${d.name}`} title="Remove"><IconTrash size={16} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <DeviceDialog
          kind={kind}
          device={editing === 'new' ? null : editing}
          locations={locations}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); devicesQ.reload() }}
        />
      )}
    </div>
  )
}

/** A switch with an ON / OFF chip beside its label, and what it means under it. */
function VerifySwitch({
  label, hint, on, onChange, children,
}: {
  label: string
  hint: string
  on: boolean
  onChange: (on: boolean) => void
  children?: ReactNode
}) {
  return (
    <div className="hs-verify-row">
      <div className="hs-verify-head">
        <button type="button" role="switch" aria-checked={on} aria-label={label} className={`hs-switch${on ? ' is-on' : ''}`} onClick={() => onChange(!on)}>
          <span />
        </button>
        <b>{label}</b>
        <span className={`hs-onoff${on ? ' is-on' : ''}`}>{on ? 'ON' : 'OFF'}</span>
      </div>
      <p className="muted-sm hs-verify-hint">{hint}</p>
      {on && children}
    </div>
  )
}

function DeviceDialog({
  kind, device, onClose, onSaved,
}: {
  kind: 'face' | 'biometric'
  device: AttendanceDevice | null
  locations: OfficeLocation[]
  onClose: () => void
  onSaved: () => void
}) {
  const branchesQ = useQuery<Array<{ id: string; name: string; is_active: boolean }>>('branches', () => api.get('/org/branches'))
  const [form, setForm] = useState({
    name: device?.name ?? '',
    branch_id: device?.branch_id ?? '',
    location_required: device?.location_required ?? false,
    lat: device?.lat === null || device?.lat === undefined ? '' : String(device.lat),
    lng: device?.lng === null || device?.lng === undefined ? '' : String(device.lng),
    radius_m: device?.radius_m === null || device?.radius_m === undefined ? '' : String(device.radius_m),
    ip_required: device?.ip_required ?? false,
    allowed_ips: device?.allowed_ips ?? '',
    cooldown_s: String(device?.cooldown_s ?? 120),
    allowed_from_min: String(device?.allowed_from_min ?? 120),
    allowed_until_min: String(device?.allowed_until_min ?? 240),
    is_active: device?.is_active ?? true,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pinning, setPinning] = useState(false)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  function pin() {
    if (!navigator.geolocation) return setError('This browser cannot tell where you are.')
    setPinning(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        set({ lat: pos.coords.latitude.toFixed(6), lng: pos.coords.longitude.toFixed(6), radius_m: form.radius_m || '150' })
        setPinning(false)
      },
      () => { setError('Could not read your location. Allow it in the browser, or type the coordinates.'); setPinning(false) },
      { enableHighAccuracy: true, timeout: 10000 },
    )
  }

  const whole = (value: string) => value.trim() !== '' && Number.isInteger(Number(value)) && Number(value) >= 0

  async function save() {
    if (!form.name.trim()) return setError('Give it a name.')
    const lat = Number(form.lat)
    const lng = Number(form.lng)
    const radius = Number(form.radius_m)
    if (form.location_required) {
      if (form.lat.trim() === '' || form.lng.trim() === '' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return setError('Location required needs a latitude and a longitude.')
      }
      if (!Number.isInteger(radius) || radius < 25 || radius > 20000) return setError('Radius is between 25 and 20,000 metres.')
    }
    if (form.ip_required && form.allowed_ips.trim() === '') return setError('IP address required needs at least one allowed address.')
    if (![form.cooldown_s, form.allowed_from_min, form.allowed_until_min].every(whole)) return setError('Timing values are whole numbers, 0 or more.')
    setBusy(true)
    setError(null)
    const body = {
      kind,
      name: form.name.trim(),
      branch_id: form.branch_id || null,
      location_required: form.location_required,
      lat: form.location_required ? lat : null,
      lng: form.location_required ? lng : null,
      radius_m: form.location_required ? radius : null,
      ip_required: form.ip_required,
      allowed_ips: form.ip_required ? form.allowed_ips : null,
      cooldown_s: Number(form.cooldown_s),
      allowed_from_min: Number(form.allowed_from_min),
      allowed_until_min: Number(form.allowed_until_min),
      is_active: form.is_active,
      device_code: device?.device_code ?? null,
      location_id: device?.location_id ?? null,
    }
    try {
      if (device) await api.patch(`/attendance/devices/${device.id}`, body)
      else await api.post('/attendance/devices', body)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be saved')
      setBusy(false)
    }
  }

  const note = form.location_required && form.ip_required
    ? 'A punch here must be inside the radius AND on an allowed network. Both are checked; either one refuses it.'
    : form.location_required
      ? 'A punch here must be inside the radius. The network is not checked.'
      : form.ip_required
        ? 'A punch here must come from an allowed network. The location is not checked.'
        : 'No location or network restriction — a punch here is accepted from anywhere.'

  return (
    <Dialog
      title={device ? `Edit ${device.name}` : 'New attendance link or device'}
      medium
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary hs-create" onClick={save} disabled={busy || !form.name.trim()}>
            {busy ? 'Saving…' : device ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="crm-form">
        {error && <div className="crm-form-wide"><ErrorNote>{error}</ErrorNote></div>}
        <Field label="Name" required>
          <input value={form.name} placeholder="Shop entrance" autoFocus onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Branch" hint="Blank means the whole account">
          <select value={form.branch_id} onChange={(e) => set({ branch_id: e.target.value })}>
            <option value="">All branches</option>
            {(branchesQ.data ?? []).filter((b) => b.is_active || b.id === form.branch_id).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>

        <div className="crm-form-wide hs-verify">
          <span className="hs-verify-title">Verification</span>
          <VerifySwitch label="Location Required" hint="The punch must be inside the radius below." on={form.location_required} onChange={(on) => set({ location_required: on })}>
            <div className="hs-verify-fields">
              <Field label="Latitude"><input value={form.lat} inputMode="decimal" placeholder="18.520430" onChange={(e) => set({ lat: e.target.value })} /></Field>
              <Field label="Longitude"><input value={form.lng} inputMode="decimal" placeholder="73.856744" onChange={(e) => set({ lng: e.target.value })} /></Field>
              <Field label="Radius (m)" hint="100-200 suits most doors"><input value={form.radius_m} inputMode="numeric" onChange={(e) => set({ radius_m: e.target.value })} /></Field>
            </div>
            <button type="button" className="btn hs-pin" onClick={pin} disabled={pinning}>
              <IconPin size={14} /> {pinning ? 'Finding you…' : 'Pin to where I am now'}
            </button>
          </VerifySwitch>
          <VerifySwitch label="IP Address Required" hint="The punch must come from one of the networks below." on={form.ip_required} onChange={(on) => set({ ip_required: on })}>
            <Field label="Allowed IP" hint="One per line — 203.0.113.7, 10.0.0.0/8 or 192.168.1.*">
              <textarea rows={3} value={form.allowed_ips} placeholder="203.0.113.7" onChange={(e) => set({ allowed_ips: e.target.value })} />
            </Field>
          </VerifySwitch>
          <p className={`hs-verify-note${form.location_required || form.ip_required ? ' is-on' : ''}`}>{note}</p>
        </div>

        <details className="crm-form-wide hs-timing">
          <summary>Timing</summary>
          <div className="hs-verify-fields">
            <Field label="Cooldown (s)" hint="A second scan inside this is a duplicate">
              <input value={form.cooldown_s} inputMode="numeric" onChange={(e) => set({ cooldown_s: e.target.value })} />
            </Field>
            <Field label="Allowed from (min before shift)">
              <input value={form.allowed_from_min} inputMode="numeric" onChange={(e) => set({ allowed_from_min: e.target.value })} />
            </Field>
            <Field label="Allowed until (min after shift)">
              <input value={form.allowed_until_min} inputMode="numeric" onChange={(e) => set({ allowed_until_min: e.target.value })} />
            </Field>
          </div>
        </details>

        {device && (
          <div className="crm-field crm-form-wide om-checks">
            <label className="crm-check">
              <input type="checkbox" checked={form.is_active} onChange={(e) => set({ is_active: e.target.checked })} />
              Active
            </label>
          </div>
        )}
      </div>
    </Dialog>
  )
}

/* --------------------------------------------------------------- overtime -- */

/** What counts as overtime on a timesheet. The defaults are what timesheets did before
 *  there was a policy, so nothing changes for a company until somebody edits it. */
function OvertimePolicy({
  settings, loading, error, onSaved,
}: {
  settings: AttendanceSettingsPayload | undefined
  loading: boolean
  error: string | null
  onSaved: () => void
}) {
  const action = useAction(onSaved)
  const [draft, setDraft] = useState<{ enabled: boolean; min: string; off: boolean } | null>(null)
  if (loading && !settings) return <Loading />
  if (error) return <ErrorNote>{error}</ErrorNote>
  if (!settings) return null

  const saved = { enabled: settings.overtime_enabled ?? true, min: String(settings.overtime_min_minutes ?? 0), off: settings.overtime_on_off_days ?? true }
  const form = draft ?? saved
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved)
  const minutes = Number(form.min)
  const minBad = form.min.trim() === '' || !Number.isInteger(minutes) || minutes < 0 || minutes > 480
  const set = (patch: Partial<typeof form>) => setDraft({ ...form, ...patch })

  return (
    <Section title="Overtime" note="Read by timesheets, reports and the HR dashboard">
      <Feedback failure={action.failure} notice={action.notice} />
      <div className="card-body" style={{ display: 'grid', gap: 18, maxWidth: 560 }}>
        <label className="setting" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          <span>
            <b>Count overtime</b>
            <span className="muted-sm" style={{ display: 'block' }}>
              Time worked beyond the expected day is reported as overtime. Switched off, timesheets report none.
            </span>
          </span>
        </label>

        <label className="setting">
          Minimum overtime that counts (minutes)
          <input
            type="number" min={0} max={480} inputMode="numeric" value={form.min}
            disabled={!form.enabled}
            className={minBad ? 'is-bad' : ''}
            onChange={(e) => set({ min: e.target.value })}
          />
          <span className="muted-sm">
            Anything under this many minutes past the expected day is ignored. 0 counts every minute.
          </span>
        </label>

        <label className="setting" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={form.off} disabled={!form.enabled} onChange={(e) => set({ off: e.target.checked })} />
          <span>
            <b>Work on a day off counts</b>
            <span className="muted-sm" style={{ display: 'block' }}>
              Hours worked on a weekly off or a holiday are counted whole as overtime.
            </span>
          </span>
        </label>
      </div>
      <div className="att-form-actions">
        <button
          className="btn btn-primary"
          disabled={!dirty || minBad || action.busy}
          onClick={() =>
            void action
              .run(
                () => api.put('/attendance/settings', {
                  overtime_enabled: form.enabled,
                  overtime_min_minutes: minutes,
                  overtime_on_off_days: form.off,
                }),
                'Overtime policy saved.',
              )
              .then((ok) => { if (ok) setDraft(null) })
          }
        >
          {action.busy ? 'Saving…' : 'Save'}
        </button>
        {dirty && <button className="btn btn-sm" onClick={() => { setDraft(null); action.clear() }}>Cancel</button>}
      </div>
    </Section>
  )
}

/* --------------------------------------------------------------- helpers -- */

/** Wraps a write so a `{reason, message}` refusal reaches the screen as prose. */
function useAction(onDone: () => void) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<TypedFailure | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function run(fn: () => Promise<unknown>, message: string): Promise<boolean> {
    setBusy(true)
    setFailure(null)
    setNotice(null)
    try {
      await fn()
      setNotice(message)
      onDone()
      return true
    } catch (err) {
      setFailure(typedError(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  return { busy, failure, notice, run, clear: () => { setFailure(null); setNotice(null) } }
}

function Feedback({ failure, notice }: { failure: TypedFailure | null; notice: string | null }) {
  if (failure) {
    return (
      <div style={{ marginBottom: 12 }}>
        <ErrorNote>{failure.message}</ErrorNote>
      </div>
    )
  }
  if (notice) {
    return (
      <div className="notice" style={{ marginBottom: 12 }}>
        {notice}
      </div>
    )
  }
  return null
}

function Section({
  title,
  note,
  tools,
  children,
}: {
  title: string
  note?: ReactNode
  tools?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="card" style={{ marginBottom: 14 }}>
      <div className="card-head">
        <h2 className="card-title">{title}</h2>
        {tools ?? (note ? <span className="card-note">{note}</span> : null)}
      </div>
      {children}
    </section>
  )
}

/* ----------------------------------------------------------------- policy -- */

/** Not on any screen now; kept so the policy card can be put back where it is wanted. */
export function GeofencePolicy({
  settings,
  loading,
  error,
  onSaved,
}: {
  settings: AttendanceSettingsPayload | undefined
  loading: boolean
  error: string | null
  onSaved: () => void
}) {
  const [choice, setChoice] = useState<Enforcement | null>(null)
  /* Per-mode overrides, as the wire spells them: 'inherit' is a value rather
     than null because this is a PATCH body where null already means "leave this
     field alone". Without a distinct token there would be no way to stop
     overriding a mode once you had started. */
  const [modes, setModes] = useState<Record<ModeField, string> | null>(null)
  const action = useAction(onSaved)

  if (error) return <ErrorNote>{error}</ErrorNote>
  if (loading || !settings) {
    return (
      <Section title="Geofenced punching">
        <Loading />
      </Section>
    )
  }

  const current = settings.geofence_enforcement
  const selected = choice ?? current
  const offices = settings.active_location_count
  /* The server refuses `required` with zero active offices (D-014). Saying so
     before the click is the whole point: a refusal the admin never anticipated
     reads as a broken screen, and the fix — add a location — is one section
     down where they cannot see it. */
  const requiredBlocked = offices === 0

  const currentModes: Record<ModeField, string> = {
    geofence_office: settings.geofence_office ?? 'inherit',
    geofence_work_from_home: settings.geofence_work_from_home ?? 'inherit',
    geofence_on_duty: settings.geofence_on_duty ?? 'inherit',
  }
  const selectedModes = modes ?? currentModes
  const modesDirty = MODE_ROWS.some(
    (row) => selectedModes[row.field] !== currentModes[row.field],
  )
  const dirty = selected !== current || modesDirty

  return (
    <Section
      title="Geofenced punching"
      note={`${offices} active office location${offices === 1 ? '' : 's'}`}
    >
      <Feedback failure={action.failure} notice={action.notice} />

      {requiredBlocked && (
        <div className="att-warn">
          <b>No active office locations.</b> &ldquo;Required&rdquo; is unavailable until at least
          one exists — switching it on with none configured would stop everyone in this
          organisation punching in, silently. Add a location below first.
        </div>
      )}
      {current === 'required' && offices === 1 && (
        <div className="att-warn">
          <b>One office, and punching is required.</b> Deleting or deactivating it will be refused
          for the same reason. Change the mode first, or add a second location.
        </div>
      )}

      <div className="att-choices">
        {ENFORCEMENT_COPY.map((option) => {
          const blocked = option.value === 'required' && requiredBlocked
          const on = selected === option.value
          return (
            <label
              key={option.value}
              className={`att-choice${on ? ' att-choice-on' : ''}${blocked ? ' att-choice-off' : ''}`}
            >
              <input
                type="radio"
                name="geofence-enforcement"
                value={option.value}
                checked={on}
                disabled={blocked}
                onChange={() => {
                  action.clear()
                  setChoice(option.value)
                }}
              />
              <span className="att-choice-title">
                {option.title}
                {option.value === current && (
                  <span className="badge" style={{ marginLeft: 8 }}>
                    current
                  </span>
                )}
              </span>
              <p className="att-choice-desc">
                {option.desc}
                {blocked && ' Unavailable: there is no active office location to check against.'}
              </p>
            </label>
          )
        })}
      </div>

      {/* Per-mode overrides. The org-wide choice above is the default; these say
          where it does not apply. Fencing somebody who has just declared they
          are at a client's site asks a question whose answer you already have —
          so most tenants set Work from home to Off and leave the rest alone. */}
      <div className="att-modes">
        <div className="att-modes-head">Per work mode</div>
        <p className="att-choice-desc" style={{ margin: '0 0 10px' }}>
          The employee picks a mode when they punch in, and the mode picks the rule.
          Anything left on <b>Follow default</b> uses the policy above — including
          later, if you change it.
        </p>
        {MODE_ROWS.map((row) => (
          <div className="att-mode-row" key={row.field}>
            <div>
              <div className="att-mode-name">{row.label}</div>
              <div className="att-mode-hint">{row.hint}</div>
            </div>
            <select
              value={selectedModes[row.field]}
              onChange={(e) => {
                action.clear()
                setModes({ ...selectedModes, [row.field]: e.target.value })
              }}
            >
              <option value="inherit">Follow default ({ENFORCEMENT_LABEL[current]})</option>
              <option value="off">Off</option>
              <option value="flag_only">Flag only</option>
              <option value="required" disabled={requiredBlocked}>
                Required{requiredBlocked ? ' — needs an office' : ''}
              </option>
            </select>
          </div>
        ))}
      </div>

      <div className="att-form-actions">
        <button
          className="btn btn-primary"
          disabled={!dirty || action.busy}
          onClick={() =>
            void action
              .run(
                () =>
                  api.put('/attendance/settings', {
                    geofence_enforcement: selected,
                    ...selectedModes,
                  }),
                'Geofence policy saved.',
              )
              .then((ok) => {
                if (ok) {
                  setChoice(null)
                  setModes(null)
                }
              })
          }
        >
          {action.busy ? 'Saving…' : 'Save policy'}
        </button>
        {dirty && (
          <button className="btn btn-sm" onClick={() => { setChoice(null); setModes(null); action.clear() }}>
            Cancel
          </button>
        )}
      </div>
    </Section>
  )
}

/* -------------------------------------------------------------- locations -- */

interface LocationForm {
  name: string
  address: string
  lat: string
  lng: string
  radius_m: number
  is_active: boolean
}

const BLANK_LOCATION: LocationForm = {
  name: '',
  address: '',
  lat: '',
  lng: '',
  radius_m: 200,
  is_active: true,
}

/** Not on any screen now (offices are kept in Master → Location); kept for the same reason. */
export function Locations({
  locations,
  loading,
  error,
  enforcement,
  onChanged,
}: {
  locations: OfficeLocation[]
  loading: boolean
  error: string | null
  enforcement: Enforcement | undefined
  onChanged: () => void
}) {
  const [form, setForm] = useState<LocationForm | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const action = useAction(onChanged)
  const [locating, setLocating] = useState(false)
  const [geoNote, setGeoNote] = useState<string | null>(null)
  const columns = useColumns('attendance-locations', LOCATION_COLUMNS)
  const fields = useFieldModes('attendance-location-form', LOCATION_FIELDS)
  const fm = fields.mode
  const rq = (key: string) => fm(key) === 'mandatory'

  function open(row?: OfficeLocation) {
    action.clear()
    setGeoNote(null)
    setEditing(row?.id ?? null)
    setForm(
      row
        ? {
            name: row.name,
            address: row.address ?? '',
            lat: row.lat === null ? '' : String(row.lat),
            lng: row.lng === null ? '' : String(row.lng),
            radius_m: row.radius_m,
            is_active: row.is_active,
          }
        : { ...BLANK_LOCATION },
    )
  }

  function useMyPosition() {
    if (!navigator.geolocation) {
      setGeoNote('This browser cannot report a location — type the coordinates instead.')
      return
    }
    setLocating(true)
    setGeoNote(null)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false)
        setForm((f) =>
          f
            ? {
                ...f,
                lat: position.coords.latitude.toFixed(6),
                lng: position.coords.longitude.toFixed(6),
              }
            : f,
        )
        setGeoNote(
          `Filled from this device (accurate to about ${Math.round(position.coords.accuracy)} m). Check it before saving.`,
        )
      },
      () => {
        setLocating(false)
        setGeoNote('Your browser did not give a location — type the coordinates instead.')
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
    )
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!form) return
    // Organisation → Location owns the branch and address; keep them as they are.
    const existing = locations.find((l) => l.id === editing)
    const payload = {
      name: form.name.trim(),
      address: form.address.trim() || null,
      branch_id: existing?.branch_id ?? null,
      state: existing?.state ?? null,
      district: existing?.district ?? null,
      city: existing?.city ?? null,
      lat: Number(form.lat),
      lng: Number(form.lng),
      radius_m: form.radius_m,
      is_active: form.is_active,
    }
    const ok = await action.run(
      () =>
        editing
          ? api.patch(`/attendance/locations/${editing}`, payload)
          : api.post('/attendance/locations', payload),
      editing ? 'Office location updated.' : 'Office location added.',
    )
    if (ok) {
      setForm(null)
      setEditing(null)
    }
  }

  const fieldNodes: Record<string, ReactNode> = form ? {
    name: (
      <label className="setting">
        Name
        <input
          value={form.name}
          maxLength={120}
          required
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Whitefield"
        />
      </label>
    ),
    address: fm('address') !== 'hide' && (
      <label className="setting">
        {rq('address') ? 'Address' : 'Address (optional)'}{star(rq('address'))}
        <input placeholder="e.g. Tower B, Whitefield, Bengaluru"
          value={form.address}
          maxLength={500}
          required={rq('address')}
          onChange={(e) => setForm({ ...form, address: e.target.value })}
        />
      </label>
    ),
    lat: (
      <label className="setting">
        Latitude
        <input placeholder="12.971599"
          type="number"
          step="0.000001"
          min={-90}
          max={90}
          required
          value={form.lat}
          onChange={(e) => setForm({ ...form, lat: e.target.value })}
        />
      </label>
    ),
    lng: (
      <label className="setting">
        Longitude
        <input placeholder="77.594566"
          type="number"
          step="0.000001"
          min={-180}
          max={180}
          required
          value={form.lng}
          onChange={(e) => setForm({ ...form, lng: e.target.value })}
        />
      </label>
    ),
    radius_m: fm('radius_m') !== 'hide' && (
      <label className="setting">
        Radius (metres){star(rq('radius_m'))}
        <input placeholder="100"
          type="number"
          min={25}
          max={20000}
          step={5}
          required={rq('radius_m')}
          value={form.radius_m}
          onChange={(e) => setForm({ ...form, radius_m: Number(e.target.value) })}
        />
      </label>
    ),
    is_active: fm('is_active') !== 'hide' && (
      <div className="setting">
        <label className="switch-row">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
          />
          <span>Active</span>
        </label>
      </div>
    ),
  } : {}
  const fieldsOf = (section: string) =>
    fields.orderOf(section).map((key) => <Fragment key={key}>{fieldNodes[key]}</Fragment>)

  return (
    <Section
      title="Office locations"
      tools={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <ColumnSettings defs={LOCATION_COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden}
                          onSave={columns.save} onReset={columns.reset} />
          <button className="btn btn-sm" onClick={() => (form ? setForm(null) : open())}>
            {form ? 'Cancel' : 'Add location'}
          </button>
        </div>
      }
    >
      <Feedback failure={action.failure} notice={action.notice} />

      {form && (
        <form className="att-admin-form" onSubmit={submit}>
          <div className="lf-settings">
            <FieldSettings defs={LOCATION_FIELDS} sections={LOCATION_SECTIONS} modes={fields.modes} order={fields.order}
                           onSave={fields.save} onReset={fields.reset} title="Location fields" />
          </div>
          <div className="settings-grid">
            {fieldsOf('location')}
          </div>

          <p className="setting-hint" style={{ marginTop: 10 }}>
            Anything under 25 m is tighter than ordinary phone GPS error and would flag genuine
            punches. Latitude runs −90 to 90 and longitude −180 to 180; if the two are swapped the
            server refuses rather than putting the office in the sea.
          </p>
          {geoNote && (
            <p className="setting-hint" style={{ marginTop: 6 }}>
              {geoNote}
            </p>
          )}

          <div className="att-form-actions">
            <button className="btn btn-primary" disabled={action.busy}>
              {action.busy ? 'Saving…' : editing ? 'Save location' : 'Add location'}
            </button>
            <button className="btn btn-sm" type="button" onClick={useMyPosition} disabled={locating}>
              {locating ? 'Locating…' : 'Use this device’s position'}
            </button>
            <button className="btn btn-sm" type="button" onClick={() => { setForm(null); setEditing(null) }}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && locations.length === 0 && <Loading />}

      {!loading && locations.length === 0 ? (
        <EmptyState
          title="No office locations yet"
          body={
            enforcement === 'off'
              ? 'Punching works without one — location checks are switched off. Add a location if you later want punches verified.'
              : 'Until one exists, no punch can be verified against an office and every one is recorded unverified. Add the site people actually punch from.'
          }
          action={
            !form && (
              <button className="btn btn-primary btn-sm" onClick={() => open()}>
                Add the first location
              </button>
            )
          }
        />
      ) : (
        locations.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {columns.visible.map((col) => (
                    <th key={col.key} className={(col as LocationColumn).thClass}>{col.label}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {locations.map((row) => (
                  <tr key={row.id} className={row.is_active ? undefined : 'att-closed'}>
                    {columns.visible.map((col) => (
                      <td key={col.key} className={(col as LocationColumn).className}>{(col as LocationColumn).td(row)}</td>
                    ))}
                    <td>
                      <div className="att-rowactions">
                        <button className="btn btn-sm" onClick={() => open(row)}>
                          Edit
                        </button>
                        <button
                          className="btn btn-sm"
                          disabled={action.busy}
                          onClick={() =>
                            void action.run(
                              () =>
                                api.patch(`/attendance/locations/${row.id}`, {
                                  name: row.name,
                                  address: row.address,
                                  branch_id: row.branch_id ?? null,
                                  state: row.state ?? null,
                                  district: row.district ?? null,
                                  city: row.city ?? null,
                                  lat: row.lat,
                                  lng: row.lng,
                                  radius_m: row.radius_m,
                                  is_active: !row.is_active,
                                }),
                              row.is_active ? 'Location deactivated.' : 'Location reactivated.',
                            )
                          }
                        >
                          {row.is_active ? 'Deactivate' : 'Reactivate'}
                        </button>
                        <button
                          className="btn btn-sm"
                          disabled={action.busy}
                          onClick={() => {
                            if (
                              !window.confirm(
                                `Delete "${row.name}"? Past attendance keeps the distance it measured, so nothing is rewritten — but deactivating is the safer habit.`,
                              )
                            )
                              return
                            void action.run(
                              () => api.del(`/attendance/locations/${row.id}`),
                              'Location deleted.',
                            )
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </Section>
  )
}

/* ----------------------------------------------------------------- shifts -- */

interface ShiftForm {
  name: string
  start_time: string
  end_time: string
  grace_minutes: number
  /** Typed in hours because that is how a policy is written; converted to
      minutes at the request boundary, which is the only unit the wire has. */
  half_day_threshold_hours: number
  is_night_shift: boolean
  is_active: boolean
}

const BLANK_SHIFT: ShiftForm = {
  name: '',
  start_time: '09:00',
  end_time: '18:00',
  grace_minutes: 15,
  half_day_threshold_hours: 4,
  is_night_shift: false,
  is_active: true,
}

function Shifts({
  shifts,
  loading,
  error,
  onChanged,
}: {
  shifts: Shift[]
  loading: boolean
  error: string | null
  onChanged: () => void
}) {
  const [form, setForm] = useState<ShiftForm | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const action = useAction(onChanged)
  const columns = useColumns('attendance-shifts', SHIFT_COLUMNS)
  const fields = useFieldModes('attendance-shift-form', SHIFT_FIELDS)
  const fm = fields.mode
  const rq = (key: string) => fm(key) === 'mandatory'

  function open(row?: Shift) {
    action.clear()
    setEditing(row?.id ?? null)
    setForm(
      row
        ? {
            name: row.name,
            start_time: row.start_time,
            end_time: row.end_time,
            grace_minutes: row.grace_minutes,
            half_day_threshold_hours: row.half_day_threshold_minutes / 60,
            is_night_shift: row.is_night_shift,
            is_active: row.is_active,
          }
        : { ...BLANK_SHIFT },
    )
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!form) return
    const payload = {
      name: form.name.trim(),
      start_time: form.start_time,
      end_time: form.end_time,
      grace_minutes: form.grace_minutes,
      // Minutes on the wire, hours on the screen (D-012). Converted here and
      // nowhere else, so the two can never drift.
      half_day_threshold_minutes: Math.round(form.half_day_threshold_hours * 60),
      is_night_shift: form.is_night_shift,
      is_active: form.is_active,
    }
    const ok = await action.run(
      () =>
        editing
          ? api.patch(`/attendance/shifts/${editing}`, payload)
          : api.post('/attendance/shifts', payload),
      editing
        ? 'Shift saved. Days already classified keep the timings they were judged against until they are recomputed.'
        : 'Shift created.',
    )
    if (ok) {
      setForm(null)
      setEditing(null)
    }
  }

  const fieldNodes: Record<string, ReactNode> = form ? {
    name: (
      <label className="setting">
        Name
        <input
          value={form.name}
          maxLength={120}
          required
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="General"
        />
      </label>
    ),
    start_time: fm('start_time') !== 'hide' && (
      <label className="setting">
        Starts{star(rq('start_time'))}
        <input
          type="time"
          required={rq('start_time')}
          value={form.start_time}
          onChange={(e) => setForm({ ...form, start_time: e.target.value })}
        />
      </label>
    ),
    end_time: fm('end_time') !== 'hide' && (
      <label className="setting">
        Ends{star(rq('end_time'))}
        <input
          type="time"
          required={rq('end_time')}
          value={form.end_time}
          onChange={(e) => setForm({ ...form, end_time: e.target.value })}
        />
      </label>
    ),
    grace_minutes: fm('grace_minutes') !== 'hide' && (
      <label className="setting">
        Grace (minutes){star(rq('grace_minutes'))}
        <input placeholder="10"
          type="number"
          min={0}
          max={240}
          required={rq('grace_minutes')}
          value={form.grace_minutes}
          onChange={(e) => setForm({ ...form, grace_minutes: Number(e.target.value) })}
        />
      </label>
    ),
    half_day_threshold_hours: fm('half_day_threshold_hours') !== 'hide' && (
      <label className="setting">
        Half-day threshold (hours){star(rq('half_day_threshold_hours'))}
        <input placeholder="4"
          type="number"
          min={0.5}
          max={12}
          step={0.25}
          required={rq('half_day_threshold_hours')}
          value={form.half_day_threshold_hours}
          onChange={(e) =>
            setForm({ ...form, half_day_threshold_hours: Number(e.target.value) })
          }
        />
      </label>
    ),
    is_night_shift: fm('is_night_shift') !== 'hide' && (
      <div className="setting">
        <label className="switch-row">
          <input
            type="checkbox"
            checked={form.is_night_shift}
            onChange={(e) => setForm({ ...form, is_night_shift: e.target.checked })}
          />
          <span>Night shift (ends the next day)</span>
        </label>
      </div>
    ),
    is_active: fm('is_active') !== 'hide' && (
      <div className="setting">
        <label className="switch-row">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
          />
          <span>Active</span>
        </label>
      </div>
    ),
  } : {}
  const fieldsOf = (section: string) =>
    fields.orderOf(section).map((key) => <Fragment key={key}>{fieldNodes[key]}</Fragment>)

  return (
    <Section
      title="Shifts"
      tools={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <ColumnSettings defs={SHIFT_COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden}
                          onSave={columns.save} onReset={columns.reset} />
          <button className="btn btn-sm" onClick={() => (form ? setForm(null) : open())}>
            {form ? 'Cancel' : 'Add shift'}
          </button>
        </div>
      }
    >
      <Feedback failure={action.failure} notice={action.notice} />

      {form && (
        <form className="att-admin-form" onSubmit={submit}>
          <div className="lf-settings">
            <FieldSettings defs={SHIFT_FIELDS} sections={SHIFT_SECTIONS} modes={fields.modes} order={fields.order}
                           onSave={fields.save} onReset={fields.reset} title="Shift fields" />
          </div>
          <div className="settings-grid">
            {fieldsOf('shift')}
          </div>

          <p className="setting-hint" style={{ marginTop: 10 }}>
            Grace decides <em>whether</em> somebody is late, not how late: a 20-minute arrival
            under a 15-minute grace is reported as 20 minutes late, counted from the shift start.
            Below the half-day threshold a worked day is classified <b>half day</b> by the nightly
            job.
          </p>

          <div className="att-form-actions">
            <button className="btn btn-primary" disabled={action.busy}>
              {action.busy ? 'Saving…' : editing ? 'Save shift' : 'Create shift'}
            </button>
            <button className="btn btn-sm" type="button" onClick={() => { setForm(null); setEditing(null) }}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && shifts.length === 0 && <Loading />}

      {!loading && shifts.length === 0 ? (
        <EmptyState
          title="No shifts yet"
          body="A shift is what makes a punch late or early — without one, nobody can be late and every day is judged only on hours worked. Create the standard working day first, then put people on it below."
          action={
            !form && (
              <button className="btn btn-primary btn-sm" onClick={() => open()}>
                Create the first shift
              </button>
            )
          }
        />
      ) : (
        shifts.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {columns.visible.map((col) => (
                    <th key={col.key} className={(col as ShiftColumn).thClass}>{col.label}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {shifts.map((row) => (
                  <tr key={row.id} className={row.is_active ? undefined : 'att-closed'}>
                    {columns.visible.map((col) => (
                      <td key={col.key} className={(col as ShiftColumn).className}>{(col as ShiftColumn).td(row)}</td>
                    ))}
                    <td>
                      <div className="att-rowactions">
                        <button className="btn btn-sm" onClick={() => open(row)}>
                          Edit
                        </button>
                        <button
                          className="btn btn-sm"
                          disabled={action.busy}
                          onClick={() => {
                            if (!window.confirm(`Delete "${row.name}"?`)) return
                            void action.run(
                              () => api.del(`/attendance/shifts/${row.id}`),
                              'Shift deleted.',
                            )
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </Section>
  )
}

/* ------------------------------------------------------------------- rota -- */

function Rota({
  rota,
  loading,
  error,
  shifts,
  employees,
  today,
  onChanged,
}: {
  rota: ShiftAssignment[] | undefined
  loading: boolean
  error: string | null
  shifts: Shift[]
  employees: User[]
  today: string
  onChanged: () => void
}) {
  const action = useAction(onChanged)
  const [form, setForm] = useState({
    user_id: '',
    shift_id: '',
    effective_from: today,
    effective_to: '',
  })
  const [showClosed, setShowClosed] = useState(false)
  const columns = useColumns('attendance-rota', ROTA_COLUMNS)
  const fields = useFieldModes('attendance-rota-form', ROTA_FIELDS)
  const fm = fields.mode
  const rq = (key: string) => fm(key) === 'mandatory'

  const activeShifts = shifts.filter((s) => s.is_active)
  const people = employees.filter((e) => e.is_active)
  const rows = (rota ?? []).filter((row) => (showClosed ? true : row.is_current))
  const backdated = form.effective_from < today

  async function submit(event: FormEvent) {
    event.preventDefault()
    const ok = await action.run(
      () =>
        api.post('/attendance/shift-assignments', {
          user_id: form.user_id,
          shift_id: form.shift_id,
          effective_from: form.effective_from,
          effective_to: form.effective_to || null,
        }),
      backdated
        ? 'Assigned. The previous row was closed the day before, and the days from that date have been re-classified against the new shift.'
        : 'Assigned. The previous row was closed the day before this one starts.',
    )
    if (ok) setForm({ user_id: '', shift_id: '', effective_from: today, effective_to: '' })
  }

  const fieldNodes: Record<string, ReactNode> = {
    user_id: (
      <label className="setting">
        Employee
        <select
          required
          value={form.user_id}
          onChange={(e) => setForm({ ...form, user_id: e.target.value })}
        >
          <option value="">Choose someone…</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.full_name}
            </option>
          ))}
        </select>
      </label>
    ),
    shift_id: (
      <label className="setting">
        Shift
        <select
          required
          value={form.shift_id}
          onChange={(e) => setForm({ ...form, shift_id: e.target.value })}
        >
          <option value="">Choose a shift…</option>
          {activeShifts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.start_time}–{s.end_time})
            </option>
          ))}
        </select>
      </label>
    ),
    effective_from: (
      <label className="setting">
        Effective from
        <input
          type="date"
          required
          value={form.effective_from}
          onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
        />
      </label>
    ),
    effective_to: fm('effective_to') !== 'hide' && (
      <label className="setting">
        {rq('effective_to') ? 'Effective to' : 'Effective to (optional)'}{star(rq('effective_to'))}
        <input
          type="date"
          required={rq('effective_to')}
          value={form.effective_to}
          min={form.effective_from}
          onChange={(e) => setForm({ ...form, effective_to: e.target.value })}
        />
      </label>
    ),
  }
  const fieldsOf = (section: string) =>
    fields.orderOf(section).map((key) => <Fragment key={key}>{fieldNodes[key]}</Fragment>)

  return (
    <Section
      title="Who is on which shift"
      tools={
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <ColumnSettings defs={ROTA_COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden}
                          onSave={columns.save} onReset={columns.reset} />
          <label className="switch-row">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
            />
            <span>Show closed rows</span>
          </label>
        </div>
      }
    >
      <Feedback failure={action.failure} notice={action.notice} />

      {/* D-011 stated where it can be acted on. An admin who believes they just
          edited history will be surprised when last month's late marks do not
          move; an admin who wants them to move needs to know to backdate. */}
      <div className="att-warn">
        <b>Assignments are dated, not edited.</b> Putting someone on a new shift closes their
        current row the day before the new one starts — the old row stays, because the nightly job
        has to be able to ask which shift a person was on last March. To change how <em>past</em>{' '}
        days were judged, set <b>Effective from</b> to a date in the past: that re-classifies the
        days from then onwards. Editing the shift&rsquo;s timings above does <em>not</em> move
        days that were already classified.
      </div>

      {activeShifts.length === 0 ? (
        <EmptyState
          title="Nothing to assign yet"
          body="Create an active shift above before putting anyone on the rota."
        />
      ) : (
        <form className="att-admin-form" onSubmit={submit}>
          <div className="lf-settings">
            <FieldSettings defs={ROTA_FIELDS} sections={ROTA_SECTIONS} modes={fields.modes} order={fields.order}
                           onSave={fields.save} onReset={fields.reset} title="Assignment fields" />
          </div>
          <div className="settings-grid">
            {fieldsOf('assignment')}
          </div>

          <p className="setting-hint" style={{ marginTop: 10 }}>
            {backdated
              ? `Backdated to ${form.effective_from}. Every attendance day from then to today will be re-classified against this shift — late marks and half-days included.`
              : `Their current row, if any, will be closed on ${addDays(form.effective_from, -1)}. Leave "effective to" empty for an open-ended assignment.`}
          </p>

          <div className="att-form-actions">
            <button className="btn btn-primary" disabled={action.busy || !form.user_id || !form.shift_id}>
              {action.busy ? 'Assigning…' : 'Assign shift'}
            </button>
          </div>
        </form>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !rota && <Loading />}

      {rota && rota.length === 0 ? (
        <EmptyState
          title="Nobody is on a shift"
          body="Until someone is assigned, their days carry no shift at all: nothing counts as late or early, and the calendar says 'unassigned'."
        />
      ) : (
        rota &&
        (rows.length === 0 ? (
          <Empty>No current assignments. Tick &ldquo;show closed rows&rdquo; to see history.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {columns.visible.map((col) => (
                    <th key={col.key} className={(col as RotaColumn).thClass}>{col.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className={row.is_current ? undefined : 'att-closed'}>
                    {columns.visible.map((col) => (
                      <td key={col.key} className={(col as RotaColumn).className}>{(col as RotaColumn).td(row)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </Section>
  )
}

/* -------------------------------------------------------------- recompute -- */

function Recompute({ today }: { today: string }) {
  const [start, setStart] = useState(() => addDays(today, -7))
  const [end, setEnd] = useState(() => addDays(today, -1))
  const [result, setResult] = useState<string | null>(null)
  const action = useAction(() => {})

  return (
    <Section title="Re-classify past days" note="Only days that have already ended">
      <Feedback failure={action.failure} notice={null} />
      <p className="setting-hint" style={{ marginTop: 0 }}>
        Re-runs the nightly classification over a range. Use it after importing history or fixing a
        holiday calendar. Days already corrected by an approved regularisation are skipped — a
        human decision outranks a derived one — and today cannot be recomputed because it has not
        finished.
      </p>
      <div className="settings-grid">
        <label className="setting">
          From
          <input type="date" value={start} max={addDays(today, -1)} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="setting">
          To
          <input type="date" value={end} max={addDays(today, -1)} onChange={(e) => setEnd(e.target.value)} />
        </label>
      </div>
      <div className="att-form-actions">
        <button
          className="btn"
          disabled={action.busy || !start || !end}
          onClick={() =>
            void action
              .run(async () => {
                setResult(null)
                const totals = await api.post<Record<string, number>>(
                  `/attendance/recompute?start=${start}&end=${end}`,
                )
                setResult(
                  Object.entries(totals)
                    .map(([key, value]) => `${key.replace(/_/g, ' ')}: ${value}`)
                    .join(' · '),
                )
              }, 'done')
              .then(() => undefined)
          }
        >
          {action.busy ? 'Recomputing…' : 'Recompute range'}
        </button>
        {result && <span className="muted-sm">{result}</span>}
      </div>
    </Section>
  )
}
