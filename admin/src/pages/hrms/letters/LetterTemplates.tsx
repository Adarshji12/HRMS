/* Letter templates — the bodies letters are generated from.

   The field picker is the point of this screen. A merge token that the server
   cannot resolve is refused at save time, so the editor shows the vocabulary
   rather than letting somebody guess at `{{employee.name}}` and find out three
   weeks later when a letter reaches a new hire saying "Dear ,".

   `employee_requestable` defaults off and is worth understanding: it is what
   puts a template into the self-service list. On for an address proof, off for
   a warning letter — and off is the default precisely because the failure of
   getting it wrong is one-directional. */

import { useMemo, useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type { LetterTemplate, LetterType, MergeField } from '../../../lib/types'
import { typeLabel } from './Letters'
import '../../../styles/letters.css'

const TYPES: LetterType[] = [
  'offer', 'appointment', 'confirmation', 'probation_extension', 'experience',
  'relieving', 'salary_certificate', 'address_proof', 'warning', 'custom',
]

const BLANK = {
  name: '',
  letter_type: 'custom' as LetterType,
  subject: '',
  body: '',
  signatory_name: '',
  signatory_title: '',
  employee_requestable: false,
  is_active: true,
}

export default function LetterTemplates() {
  const listQ = useQuery<LetterTemplate[]>('letter-templates-all', () =>
    api.get<LetterTemplate[]>('/letters/templates'),
  )
  const fieldsQ = useQuery<MergeField[]>('letter-fields', () =>
    api.get<MergeField[]>('/letters/fields'),
  )
  const [editing, setEditing] = useState<LetterTemplate | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      listQ.reload()
      setEditing(null)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Letter templates</h1>
          <p className="muted">
            Bodies with <code>{'{{merge.fields}}'}</code> in them. Editing one
            changes the next letter issued from it and nothing about the last.
          </p>
        </div>
        <div className="lt-head-actions">
          {!listQ.data?.length && (
            <button
              className="btn"
              disabled={busy}
              onClick={() => run(() => api.post('/letters/templates/seed'))}
            >
              Add the standard five
            </button>
          )}
          <button className="btn primary" onClick={() => setEditing('new')}>
            New template
          </button>
        </div>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      {editing && (
        <Editor
          template={editing === 'new' ? null : editing}
          fields={fieldsQ.data ?? []}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(body) =>
            run(() =>
              editing === 'new'
                ? api.post('/letters/templates', body)
                : api.patch(`/letters/templates/${editing.id}`, body),
            )
          }
        />
      )}

      {listQ.loading ? (
        <Loading />
      ) : listQ.error ? (
        <ErrorNote>{listQ.error}</ErrorNote>
      ) : !listQ.data?.length ? (
        <Empty>
          No templates yet. Add the standard five to get appointment,
          confirmation, experience, address-proof and relieving letters.
        </Empty>
      ) : (
        <>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th><th>Type</th><th>Self-service</th>
                <th>Active</th><th />
              </tr>
            </thead>
            <tbody>
              {listQ.data.map((template) => (
                <tr key={template.id}>
                  <td>
                    <div className="lt-name">{template.name}</div>
                    {template.subject && <div className="muted">{template.subject}</div>}
                  </td>
                  <td>{typeLabel(template.letter_type)}</td>
                  <td>
                    {template.employee_requestable
                      ? <span className="lt-ok">Employees may request</span>
                      : <span className="muted">HR only</span>}
                  </td>
                  <td>{template.is_active ? 'Yes' : <span className="muted">No</span>}</td>
                  <td className="row-actions">
                    <button className="btn small" onClick={() => setEditing(template)}>
                      Edit
                    </button>
                    <button
                      className="btn small danger"
                      disabled={busy}
                      onClick={() => run(() => api.del(`/letters/templates/${template.id}`))}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted">
          Deleting a template leaves every letter already issued from it intact
          and readable — those are records of what the company told somebody.
        </p>
        </>
      )}
    </div>
  )
}

function Editor({
  template,
  fields,
  busy,
  onCancel,
  onSave,
}: {
  template: LetterTemplate | null
  fields: MergeField[]
  busy: boolean
  onCancel: () => void
  onSave: (body: Record<string, unknown>) => void
}) {
  const [draft, setDraft] = useState(() =>
    template
      ? {
          name: template.name,
          letter_type: template.letter_type,
          subject: template.subject ?? '',
          body: template.body,
          signatory_name: template.signatory_name ?? '',
          signatory_title: template.signatory_title ?? '',
          employee_requestable: template.employee_requestable,
          is_active: template.is_active,
        }
      : { ...BLANK },
  )

  const known = useMemo(() => new Set(fields.map((f) => f.token)), [fields])

  /* The same validation the server runs, run here first so the author sees the
     typo while they are looking at the body rather than after a failed save. */
  const unknown = useMemo(() => {
    const found = new Set<string>()
    for (const match of draft.body.matchAll(/\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/g)) {
      if (!known.has(match[1])) found.add(match[1])
    }
    return [...found].sort()
  }, [draft.body, known])

  const grouped = useMemo(() => {
    const buckets = new Map<string, MergeField[]>()
    for (const field of fields) {
      if (!buckets.has(field.group)) buckets.set(field.group, [])
      buckets.get(field.group)!.push(field)
    }
    return [...buckets.entries()]
  }, [fields])

  function insert(token: string) {
    setDraft((prev) => ({ ...prev, body: `${prev.body}{{${token}}}` }))
  }

  return (
    <section className="card lt-editor">
      <h2 className="card-title">{template ? `Edit ${template.name}` : 'New template'}</h2>

      <div className="lt-editor-grid">
        <div className="lt-editor-main">
          <label className="lt-field">
            <span className="lt-field-label">Name</span>
            <input value={draft.name}
                   onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <div className="lt-compose-row">
            <label className="lt-field">
              <span className="lt-field-label">Type</span>
              <select value={draft.letter_type}
                      onChange={(e) =>
                        setDraft({ ...draft, letter_type: e.target.value as LetterType })}>
                {TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
              </select>
            </label>
            <label className="lt-field lt-field-wide">
              <span className="lt-field-label">Heading on the letter</span>
              <input value={draft.subject}
                     onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                     placeholder="e.g. To Whom It May Concern" />
            </label>
          </div>

          <label className="lt-field">
            <span className="lt-field-label">Body</span>
            <textarea
              className="lt-body-edit"
              rows={16}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              placeholder="Dear {{employee.full_name}},"
            />
            <span className="lt-field-hint">
              Blank lines separate paragraphs. The letterhead, reference number
              and date are added when the letter is issued.
            </span>
          </label>

          {unknown.length > 0 && (
            <ErrorNote>
              Unknown merge fields: {unknown.map((t) => `{{${t}}}`).join(', ')}.
              Pick from the list on the right — the server will refuse this
              template otherwise.
            </ErrorNote>
          )}

          <div className="lt-compose-row">
            <label className="lt-field">
              <span className="lt-field-label">Signed by</span>
              <input value={draft.signatory_name}
                     onChange={(e) => setDraft({ ...draft, signatory_name: e.target.value })} />
            </label>
            <label className="lt-field">
              <span className="lt-field-label">Title</span>
              <input value={draft.signatory_title}
                     onChange={(e) => setDraft({ ...draft, signatory_title: e.target.value })} />
            </label>
          </div>

          <label className="lt-check">
            <input type="checkbox" checked={draft.employee_requestable}
                   onChange={(e) =>
                     setDraft({ ...draft, employee_requestable: e.target.checked })} />
            <span>
              Employees may request this letter
              <span className="lt-field-hint">
                Puts it in self-service. Right for an address proof; wrong for a
                warning letter.
              </span>
            </span>
          </label>
          <label className="lt-check">
            <input type="checkbox" checked={draft.is_active}
                   onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })} />
            <span>Active</span>
          </label>

          <div className="lt-actions">
            <button
              className="btn primary"
              disabled={busy || !draft.name.trim() || !draft.body.trim() || unknown.length > 0}
              onClick={() => onSave(draft)}
            >
              {busy ? 'Saving…' : 'Save template'}
            </button>
            <button className="btn" onClick={onCancel}>Cancel</button>
          </div>
        </div>

        <aside className="lt-fields">
          <h3 className="lt-subhead">Merge fields</h3>
          <p className="lt-field-hint">
            Click to append. Statutory numbers and bank details are deliberately
            absent — those are encrypted and audited, and a merge field would
            put them in plain text in every letter.
          </p>
          {grouped.map(([group, list]) => (
            <div key={group} className="lt-field-group">
              <div className="lt-field-group-title">{group}</div>
              {list.map((field) => (
                <button key={field.token} type="button" className="lt-token"
                        onClick={() => insert(field.token)}
                        title={`e.g. ${field.example}`}>
                  {field.label}
                </button>
              ))}
            </div>
          ))}
        </aside>
      </div>
    </section>
  )
}
