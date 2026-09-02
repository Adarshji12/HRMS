/* Daily Reminders — scheduled WhatsApp messages to a list, the leads, or the
 * customers.
 *
 * **This product has no WhatsApp sender wired in yet, and the page says so
 * rather than implying otherwise.** The scheduler resolves each reminder's
 * audience on the day it is due and writes a run row saying what would have
 * gone out; the History tab shows those rows verbatim. That is deliberate: a
 * campaign screen that looks like it is sending, and is not, is worse than one
 * that is honest about what is wired up — and every part of this except the
 * final hop is real, so connecting a sender later changes nothing here.
 *
 * The wizard saves as a draft and never activates by itself. A half-built
 * campaign must not go out because somebody closed the dialog, so `is_active`
 * is a deliberate switch on the list, not a side effect of saving.
 */

import { useState } from 'react'
import '../../styles/crm.css'
import { useQuery } from '../../lib/useQuery'
import { shortDate } from '../../lib/format'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconBell, IconCheck, IconClock, IconPlus, IconUsers } from '../../components/Icons'
import {
  crm,
  crmError,
  daysFromTodayISO,
  todayISO,
  type Reminder,
  type ReminderRecipient,
  type ReminderRun,
} from './api'
import { CrmPage, Dialog, Field, MasterSelect } from './parts'

const DAYS = [
  { iso: 1, label: 'M' },
  { iso: 2, label: 'T' },
  { iso: 3, label: 'W' },
  { iso: 4, label: 'T' },
  { iso: 5, label: 'F' },
  { iso: 6, label: 'S' },
  { iso: 7, label: 'S' },
]

export default function DailyReminders() {
  const [tab, setTab] = useState<'reminders' | 'history'>('reminders')
  const [editing, setEditing] = useState<Reminder | null>(null)
  const [creating, setCreating] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)

  const reminders = useQuery<Reminder[]>('crm-reminders', () => crm.reminders())
  const history = useQuery<ReminderRun[]>('crm-reminder-history', () => crm.reminderHistory(), {
    enabled: tab === 'history',
  })
  const settings = useQuery('crm-settings-reminders', () => crm.settings().catch(() => null))

  const list = reminders.data ?? []
  const active = list.filter((row) => row.is_active).length
  const running = list.filter((row) => row.is_active && row.last_run_on).length

  async function toggle(reminder: Reminder, next: boolean) {
    setRowError(null)
    try {
      await crm.toggleReminder(reminder.id, next)
      reminders.reload()
    } catch (err) {
      setRowError(crmError(err, 'That reminder could not be switched'))
    }
  }

  async function remove(reminder: Reminder) {
    setRowError(null)
    try {
      await crm.deleteReminder(reminder.id)
      reminders.reload()
    } catch (err) {
      setRowError(crmError(err, 'That reminder could not be deleted'))
    }
  }

  async function setMasterSwitch(enabled: boolean) {
    setRowError(null)
    try {
      await crm.saveSettings({ reminders_enabled: enabled })
      settings.reload()
    } catch (err) {
      setRowError(crmError(err, 'That setting could not be saved'))
    }
  }

  if (reminders.error && !reminders.data) {
    return (
      <CrmPage title="Daily Reminders">
        <ErrorNote>{crmError(reminders.cause, 'Could not load your reminders')}</ErrorNote>
      </CrmPage>
    )
  }

  return (
    <CrmPage
      title="Daily Reminders"
      subtitle="Scheduled WhatsApp reminders to a list, your leads or your customers"
      actions={
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <IconPlus size={15} /> New reminder
        </button>
      }
    >
      <div className="notice notice-warn" style={{ marginBottom: 16 }}>
        No WhatsApp sender is connected to this workspace yet, so nothing is delivered. Every
        reminder still runs on schedule and records who it would have reached — see History.
      </div>

      <div className="crm-bar">
        <span className="crm-pill">
          <IconBell size={13} /> {active} active / {list.length}
        </span>
        <span className="crm-pill">
          <IconCheck size={13} /> {running} have run
        </span>
        <label className="crm-check crm-push">
          <input
            type="checkbox"
            checked={Boolean(settings.data?.reminders_enabled)}
            onChange={(event) => setMasterSwitch(event.target.checked)}
          />
          Scheduler {settings.data?.reminders_enabled ? 'ON' : 'OFF'} for this workspace
        </label>
        <div className="crm-seg">
          <button className={tab === 'reminders' ? 'crm-seg-on' : ''} onClick={() => setTab('reminders')}>
            Reminders
          </button>
          <button className={tab === 'history' ? 'crm-seg-on' : ''} onClick={() => setTab('history')}>
            History
          </button>
        </div>
      </div>

      {rowError && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{rowError}</ErrorNote>
        </div>
      )}

      {tab === 'reminders' ? (
        <section className="card">
          {list.length === 0 ? (
            reminders.loading ? (
              <Loading />
            ) : (
              <EmptyState
                icon={<IconBell size={22} />}
                title="No reminders yet"
                body="Build a message once, choose who gets it, and set the days it should go out. Nothing sends until you switch the reminder on."
                action={
                  <button className="btn btn-primary" onClick={() => setCreating(true)}>
                    Build the first reminder
                  </button>
                }
              />
            )
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Reminder</th>
                    <th>Audience</th>
                    <th>Schedule</th>
                    <th className="crm-num">Recipients</th>
                    <th>Last run</th>
                    <th>Active</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((reminder) => (
                    <tr key={reminder.id}>
                      <td>
                        <div className="crm-strong">{reminder.name}</div>
                        {reminder.message && (
                          <div className="crm-sub">{reminder.message.slice(0, 80)}</div>
                        )}
                      </td>
                      <td>
                        <span className="crm-pill">
                          {reminder.audience === 'list'
                            ? 'Typed list'
                            : reminder.audience === 'leads'
                              ? 'Leads'
                              : 'Customers'}
                        </span>
                      </td>
                      <td className="crm-sub">
                        {reminder.send_time} ·{' '}
                        {reminder.weekdays.length === 0
                          ? 'every day'
                          : reminder.weekdays.map((day) => DAYS[day - 1].label).join('')}
                        <div>
                          from {shortDate(reminder.start_on)}
                          {reminder.end_on ? ` to ${shortDate(reminder.end_on)}` : ' — no end date'}
                        </div>
                      </td>
                      <td className="crm-num">
                        {reminder.recipient_count}
                        {reminder.scheduled_sends > 0 && (
                          <div className="crm-sub">{reminder.scheduled_sends} sends left</div>
                        )}
                      </td>
                      <td className="crm-sub">
                        {reminder.last_run_on ? shortDate(reminder.last_run_on) : 'never'}
                      </td>
                      <td>
                        <label className="crm-check">
                          <input
                            type="checkbox"
                            checked={reminder.is_active}
                            onChange={(event) => toggle(reminder, event.target.checked)}
                          />
                          {reminder.is_active ? 'On' : 'Off'}
                        </label>
                      </td>
                      <td>
                        <div className="crm-row-actions">
                          <button className="link-btn" onClick={() => setEditing(reminder)}>
                            Edit
                          </button>
                          <button className="link-btn" onClick={() => remove(reminder)}>
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : (
        <section className="card">
          {history.loading ? (
            <Loading />
          ) : (history.data ?? []).length === 0 ? (
            <EmptyState
              icon={<IconClock size={22} />}
              title="Nothing has run yet"
              body="Once a reminder is active and its first send date arrives, every run is listed here — including the ones that delivered nothing, and why."
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Reminder</th>
                    <th>Run on</th>
                    <th className="crm-num">Recipients</th>
                    <th className="crm-num">Sent</th>
                    <th className="crm-num">Failed</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {(history.data ?? []).map((run) => (
                    <tr key={run.id}>
                      <td className="crm-strong">{run.reminder_name ?? '—'}</td>
                      <td className="crm-nowrap">{shortDate(run.run_on)}</td>
                      <td className="crm-num">{run.recipients}</td>
                      <td className="crm-num">{run.sent}</td>
                      <td className="crm-num">{run.failed}</td>
                      <td className="crm-sub">{run.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {(creating || editing) && (
        <ReminderWizard
          reminder={editing}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
          onSaved={() => {
            setCreating(false)
            setEditing(null)
            reminders.reload()
          }}
        />
      )}
    </CrmPage>
  )
}

/* --------------------------------------------------------------- wizard --- */

type Step = 'details' | 'audience' | 'message' | 'schedule'
const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'details', label: 'Details' },
  { key: 'audience', label: 'Who gets it' },
  { key: 'message', label: 'Message' },
  { key: 'schedule', label: 'Schedule' },
]

function ReminderWizard({
  reminder,
  onClose,
  onSaved,
}: {
  reminder: Reminder | null
  onClose: () => void
  onSaved: () => void
}) {
  const [step, setStep] = useState<Step>('details')
  const [name, setName] = useState(reminder?.name ?? '')
  const [message, setMessage] = useState(reminder?.message ?? '')
  const [imageUrl, setImageUrl] = useState(reminder?.image_url ?? '')
  const [templateName, setTemplateName] = useState(reminder?.template_name ?? '')
  const [audience, setAudience] = useState(reminder?.audience ?? 'list')
  const [statusId, setStatusId] = useState<string>(
    ((reminder?.audience_filter?.status_ids as string[] | undefined) ?? [])[0] ?? '',
  )
  const [customerStatus, setCustomerStatus] = useState<string>(
    (reminder?.audience_filter?.status as string | undefined) ?? '',
  )
  const [recipients, setRecipients] = useState<ReminderRecipient[]>(reminder?.recipients ?? [])
  const [bulk, setBulk] = useState('')
  const [startOn, setStartOn] = useState(reminder?.start_on ?? todayISO())
  const [endOn, setEndOn] = useState(reminder?.end_on ?? daysFromTodayISO(6))
  const [sendTime, setSendTime] = useState(reminder?.send_time ?? '10:00')
  const [weekdays, setWeekdays] = useState<number[]>(reminder?.weekdays ?? [])
  const [isActive, setIsActive] = useState(reminder?.is_active ?? false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scheduledSends = (() => {
    if (!endOn) return 0
    const start = new Date(Math.max(new Date(startOn).getTime(), Date.now()))
    const end = new Date(endOn)
    let count = 0
    for (const day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) {
      const iso = day.getDay() === 0 ? 7 : day.getDay()
      if (weekdays.length === 0 || weekdays.includes(iso)) count++
    }
    return count
  })()

  function addBulk() {
    const parsed = bulk
      .split(/[\n,;]/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [mobile, ...rest] = entry.split(/\s+/)
        return { mobile, name: rest.join(' ') || null }
      })
      // Deduplicated here as well as on the server: a person pasting a list
      // twice should see one row, not be told about it after saving.
      .filter(
        (entry, index, all) =>
          entry.mobile.length >= 8 &&
          all.findIndex((other) => other.mobile === entry.mobile) === index &&
          !recipients.some((existing) => existing.mobile === entry.mobile),
      )
    setRecipients((current) => [...current, ...parsed])
    setBulk('')
  }

  async function save() {
    setBusy(true)
    setError(null)
    const body = {
      name,
      message: message || null,
      image_url: imageUrl || null,
      template_name: templateName || null,
      audience,
      audience_filter:
        audience === 'leads'
          ? statusId
            ? { status_ids: [statusId] }
            : {}
          : audience === 'customers'
            ? customerStatus
              ? { status: customerStatus }
              : {}
            : {},
      start_on: startOn,
      end_on: endOn || null,
      send_time: sendTime,
      weekdays,
      is_active: isActive,
      recipients: audience === 'list' ? recipients.map(({ name: who, mobile }) => ({ name: who, mobile })) : [],
    }
    try {
      if (reminder) await crm.updateReminder(reminder.id, body)
      else await crm.createReminder(body)
      onSaved()
    } catch (err) {
      setError(crmError(err, 'That reminder could not be saved'))
      setBusy(false)
    }
  }

  const index = STEPS.findIndex((entry) => entry.key === step)
  const last = index === STEPS.length - 1

  return (
    <Dialog
      title={reminder ? `Edit ${reminder.name}` : 'New reminder'}
      onClose={onClose}
      wide
      footer={
        <div className="crm-wizard-foot" style={{ width: '100%', border: 0, padding: 0 }}>
          <span>
            <IconUsers size={13} />{' '}
            {audience === 'list' ? recipients.length : 'live'} recipient
            {audience === 'list' && recipients.length === 1 ? '' : 's'}
          </span>
          <span>
            <IconClock size={13} /> {scheduledSends || '—'} sends from {shortDate(startOn)} at{' '}
            {sendTime}
          </span>
          <label className="crm-check">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
            />
            Active
          </label>
          <div className="crm-push">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            {index > 0 && (
              <button className="btn" onClick={() => setStep(STEPS[index - 1].key)}>
                Back
              </button>
            )}
            {!last ? (
              <button
                className="btn btn-primary"
                onClick={() => setStep(STEPS[index + 1].key)}
                disabled={!name.trim()}
              >
                Next ›
              </button>
            ) : (
              <button className="btn btn-primary" onClick={save} disabled={busy || !name.trim()}>
                {busy ? 'Saving…' : 'Save reminder'}
              </button>
            )}
          </div>
        </div>
      }
    >
      <div style={{ padding: '0 20px 8px' }}>
        <div className="crm-steps">
          {STEPS.map((entry, position) => (
            <button
              key={entry.key}
              className={`crm-step${step === entry.key ? ' crm-step-on' : ''}`}
              onClick={() => setStep(entry.key)}
            >
              <span className="crm-step-num">{position + 1}</span>
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      <div className="crm-form">
        {error && (
          <div className="crm-form-wide">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        {step === 'details' && (
          <>
            <Field label="Reminder name *" wide>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Morning batch reminder"
                autoFocus
              />
            </Field>
            <Field
              label="Reminder message"
              wide
              hint="Bind it to a template variable as Reminder_Message on the Message tab."
            >
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                rows={6}
                placeholder="e.g. Your session starts at 7:00 am. Please reach 10 minutes early."
              />
            </Field>
            <Field
              label="Image URL"
              wide
              hint="WhatsApp fetches this picture from your site, so it has to stay published for as long as the reminder runs. Optional; used by image-header templates."
            >
              <input
                value={imageUrl}
                onChange={(event) => setImageUrl(event.target.value)}
                placeholder="https://example.com/banner.jpg"
              />
            </Field>
          </>
        )}

        {step === 'audience' && (
          <>
            <div className="crm-field crm-form-wide">
              <span className="crm-field-label">Who gets it</span>
              <div className="crm-choice">
                <button
                  className={audience === 'list' ? 'crm-choice-on' : ''}
                  onClick={() => setAudience('list')}
                >
                  A typed list
                </button>
                <button
                  className={audience === 'leads' ? 'crm-choice-on' : ''}
                  onClick={() => setAudience('leads')}
                >
                  My leads
                </button>
                <button
                  className={audience === 'customers' ? 'crm-choice-on' : ''}
                  onClick={() => setAudience('customers')}
                >
                  My customers
                </button>
              </div>
              <span className="crm-field-hint">
                Leads and customers are resolved on the day it sends, so somebody added tomorrow is
                included tomorrow.
              </span>
            </div>

            {audience === 'leads' && (
              <Field label="Only leads at this stage" wide>
                <MasterSelect kind="statuses" value={statusId} onChange={setStatusId} placeholder="Every stage" />
              </Field>
            )}

            {audience === 'customers' && (
              <Field label="Only customers with this status" wide>
                <select
                  value={customerStatus}
                  onChange={(event) => setCustomerStatus(event.target.value)}
                >
                  <option value="">Every customer</option>
                  <option value="active">Active</option>
                  <option value="on_hold">On hold</option>
                  <option value="expired">Expired</option>
                </select>
              </Field>
            )}

            {audience === 'list' && (
              <>
                <Field
                  label="Paste numbers"
                  wide
                  hint="One per line, or separated by commas. Add a name after the number to personalise it."
                >
                  <textarea
                    value={bulk}
                    onChange={(event) => setBulk(event.target.value)}
                    rows={4}
                    placeholder={'919000000001 Rohit Sharma\n919000000002 Anita'}
                  />
                </Field>
                <div className="crm-form-wide">
                  <button className="btn btn-sm" onClick={addBulk} disabled={!bulk.trim()}>
                    Add to the list
                  </button>
                </div>
                {recipients.length > 0 && (
                  <div className="crm-form-wide table-wrap" style={{ maxHeight: 220 }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Mobile</th>
                          <th>Name</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {recipients.map((row) => (
                          <tr key={row.mobile}>
                            <td className="crm-code">{row.mobile}</td>
                            <td>{row.name ?? '—'}</td>
                            <td>
                              <button
                                className="link-btn"
                                onClick={() =>
                                  setRecipients((current) =>
                                    current.filter((entry) => entry.mobile !== row.mobile),
                                  )
                                }
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
              </>
            )}
          </>
        )}

        {step === 'message' && (
          <>
            <Field
              label="WhatsApp template name"
              wide
              hint="The approved template this reminder sends through, once a sender is connected."
            >
              <input
                value={templateName}
                onChange={(event) => setTemplateName(event.target.value)}
                placeholder="daily_reminder_v1"
              />
            </Field>
            <div className="crm-form-wide card" style={{ padding: 14 }}>
              <div className="crm-field-label">Preview</div>
              <p style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
                {message || <span className="crm-muted">Nothing written yet.</span>}
              </p>
              {imageUrl && <p className="crm-sub">With the header image at {imageUrl}</p>}
            </div>
          </>
        )}

        {step === 'schedule' && (
          <>
            <Field label="Starts on">
              <input type="date" value={startOn} onChange={(event) => setStartOn(event.target.value)} />
            </Field>
            <Field label="Ends on" hint="Leave blank to run until you switch it off.">
              <input type="date" value={endOn} onChange={(event) => setEndOn(event.target.value)} />
            </Field>
            <Field label="Send at" hint="In your workspace's timezone, not UTC.">
              <input type="time" value={sendTime} onChange={(event) => setSendTime(event.target.value)} />
            </Field>
            <div className="crm-field">
              <span className="crm-field-label">Days</span>
              <div className="crm-days">
                {DAYS.map((day) => (
                  <button
                    key={day.iso}
                    className={`crm-day${weekdays.includes(day.iso) ? ' crm-day-on' : ''}`}
                    onClick={() =>
                      setWeekdays((current) =>
                        current.includes(day.iso)
                          ? current.filter((entry) => entry !== day.iso)
                          : [...current, day.iso].sort(),
                      )
                    }
                  >
                    {day.label}
                  </button>
                ))}
              </div>
              <span className="crm-field-hint">Nothing selected means every day.</span>
            </div>
          </>
        )}
      </div>
    </Dialog>
  )
}
