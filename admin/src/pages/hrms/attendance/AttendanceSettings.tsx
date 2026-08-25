import { useState, type FormEvent, type ReactNode } from 'react'
import '../../../styles/attendance.css'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { canAdminister, useAuth } from '../../../lib/auth'
import type { User } from '../../../lib/types'
import { Empty, EmptyState, ErrorNote, Loading } from '../../../components/ui'
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

export default function AttendanceSettings() {
  const { user, organization } = useAuth()
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
      <div className="page-head">
        <div>
          <h1 className="page-title">Attendance settings</h1>
          <p className="page-sub">
            Where punching counts from, which shifts exist, and who is on them. Shift assignment is
            dated: putting someone on a new shift closes the row they were on rather than rewriting
            it, so past days keep the shift they were actually judged against.
          </p>
        </div>
      </div>

      <GeofencePolicy
        settings={settings}
        loading={settingsQ.loading}
        error={settingsQ.error}
        onSaved={() => {
          settingsQ.reload()
          locationsQ.reload()
        }}
      />

      <Locations
        locations={locations}
        loading={locationsQ.loading}
        error={locationsQ.error}
        enforcement={settings?.geofence_enforcement}
        onChanged={() => {
          locationsQ.reload()
          settingsQ.reload()
        }}
      />

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
    </div>
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

function GeofencePolicy({
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
  const dirty = selected !== current

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

      <div className="att-form-actions">
        <button
          className="btn btn-primary"
          disabled={!dirty || action.busy}
          onClick={() =>
            void action
              .run(
                () => api.put('/attendance/settings', { geofence_enforcement: selected }),
                'Geofence policy saved.',
              )
              .then((ok) => {
                if (ok) setChoice(null)
              })
          }
        >
          {action.busy ? 'Saving…' : 'Save policy'}
        </button>
        {dirty && (
          <button className="btn btn-sm" onClick={() => { setChoice(null); action.clear() }}>
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

function Locations({
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

  function open(row?: OfficeLocation) {
    action.clear()
    setGeoNote(null)
    setEditing(row?.id ?? null)
    setForm(
      row
        ? {
            name: row.name,
            address: row.address ?? '',
            lat: String(row.lat),
            lng: String(row.lng),
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
    const payload = {
      name: form.name.trim(),
      address: form.address.trim() || null,
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

  return (
    <Section
      title="Office locations"
      tools={
        <button className="btn btn-sm" onClick={() => (form ? setForm(null) : open())}>
          {form ? 'Cancel' : 'Add location'}
        </button>
      }
    >
      <Feedback failure={action.failure} notice={action.notice} />

      {form && (
        <form className="att-admin-form" onSubmit={submit}>
          <div className="settings-grid">
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
            <label className="setting">
              Address (optional)
              <input
                value={form.address}
                maxLength={500}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
              />
            </label>
            <label className="setting">
              Latitude
              <input
                type="number"
                step="0.000001"
                min={-90}
                max={90}
                required
                value={form.lat}
                onChange={(e) => setForm({ ...form, lat: e.target.value })}
              />
            </label>
            <label className="setting">
              Longitude
              <input
                type="number"
                step="0.000001"
                min={-180}
                max={180}
                required
                value={form.lng}
                onChange={(e) => setForm({ ...form, lng: e.target.value })}
              />
            </label>
            <label className="setting">
              Radius (metres)
              <input
                type="number"
                min={25}
                max={20000}
                step={5}
                required
                value={form.radius_m}
                onChange={(e) => setForm({ ...form, radius_m: Number(e.target.value) })}
              />
            </label>
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
                  <th>Name</th>
                  <th>Coordinates</th>
                  <th className="num">Radius</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {locations.map((row) => (
                  <tr key={row.id} className={row.is_active ? undefined : 'att-closed'}>
                    <td>
                      <b>{row.name}</b>
                      {row.address && <div className="muted-sm">{row.address}</div>}
                    </td>
                    <td className="muted-sm">
                      {row.lat.toFixed(5)}, {row.lng.toFixed(5)}
                    </td>
                    <td className="num">{row.radius_m} m</td>
                    <td>
                      <span className={`badge ${row.is_active ? 'badge-ok' : ''}`}>
                        {row.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
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

  return (
    <Section
      title="Shifts"
      tools={
        <button className="btn btn-sm" onClick={() => (form ? setForm(null) : open())}>
          {form ? 'Cancel' : 'Add shift'}
        </button>
      }
    >
      <Feedback failure={action.failure} notice={action.notice} />

      {form && (
        <form className="att-admin-form" onSubmit={submit}>
          <div className="settings-grid">
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
            <label className="setting">
              Starts
              <input
                type="time"
                required
                value={form.start_time}
                onChange={(e) => setForm({ ...form, start_time: e.target.value })}
              />
            </label>
            <label className="setting">
              Ends
              <input
                type="time"
                required
                value={form.end_time}
                onChange={(e) => setForm({ ...form, end_time: e.target.value })}
              />
            </label>
            <label className="setting">
              Grace (minutes)
              <input
                type="number"
                min={0}
                max={240}
                required
                value={form.grace_minutes}
                onChange={(e) => setForm({ ...form, grace_minutes: Number(e.target.value) })}
              />
            </label>
            <label className="setting">
              Half-day threshold (hours)
              <input
                type="number"
                min={0.5}
                max={12}
                step={0.25}
                required
                value={form.half_day_threshold_hours}
                onChange={(e) =>
                  setForm({ ...form, half_day_threshold_hours: Number(e.target.value) })
                }
              />
            </label>
            <div className="setting">
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={form.is_night_shift}
                  onChange={(e) => setForm({ ...form, is_night_shift: e.target.checked })}
                />
                <span>Night shift (ends the next day)</span>
              </label>
              <label className="switch-row" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                />
                <span>Active</span>
              </label>
            </div>
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
                  <th>Shift</th>
                  <th>Hours</th>
                  <th className="num">Expected</th>
                  <th className="num">Grace</th>
                  <th className="num">Half day under</th>
                  <th className="num">On it now</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shifts.map((row) => (
                  <tr key={row.id} className={row.is_active ? undefined : 'att-closed'}>
                    <td>
                      <b>{row.name}</b>
                      {row.is_night_shift && (
                        <span className="badge" style={{ marginLeft: 8 }}>
                          night
                        </span>
                      )}
                    </td>
                    <td>
                      {row.start_time} – {row.end_time}
                    </td>
                    <td className="num">{hm(row.expected_minutes)}</td>
                    <td className="num">{row.grace_minutes}m</td>
                    <td className="num">{hm(row.half_day_threshold_minutes)}</td>
                    <td className="num">{row.assigned_count}</td>
                    <td>
                      <span className={`badge ${row.is_active ? 'badge-ok' : ''}`}>
                        {row.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
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

  return (
    <Section
      title="Who is on which shift"
      tools={
        <label className="switch-row">
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
          />
          <span>Show closed rows</span>
        </label>
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
          <div className="settings-grid">
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
            <label className="setting">
              Effective from
              <input
                type="date"
                required
                value={form.effective_from}
                onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
              />
            </label>
            <label className="setting">
              Effective to (optional)
              <input
                type="date"
                value={form.effective_to}
                min={form.effective_from}
                onChange={(e) => setForm({ ...form, effective_to: e.target.value })}
              />
            </label>
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
                  <th>Employee</th>
                  <th>Shift</th>
                  <th>From</th>
                  <th>To</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className={row.is_current ? undefined : 'att-closed'}>
                    <td>{row.user_name ?? '—'}</td>
                    <td>
                      {row.shift_name ?? '—'}
                      {row.shift_start_time && (
                        <div className="muted-sm">
                          {row.shift_start_time} – {row.shift_end_time}
                        </div>
                      )}
                    </td>
                    <td>{row.effective_from}</td>
                    <td>{row.effective_to ?? <span className="muted-sm">open-ended</span>}</td>
                    <td>
                      <span className={`badge ${row.is_current ? 'badge-ok' : ''}`}>
                        {row.is_current ? 'Current' : 'Closed'}
                      </span>
                    </td>
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
