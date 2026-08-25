/* HR letters — issue one, and see what has been issued.

   Two screens in one file because they share the whole vocabulary: a letter's
   type, its status, and the difference between a draft and an issued letter.

   Three server truths this file is built around:

   1. **Issuing freezes the text.** A draft can be reworded here; an issued
      letter has no edit path at all — not a disabled button, no path. That
      matches the API, which has no update model for an issued letter.

   2. **Preview reports two different problems.** `unknown` is a typo in the
      template and the issue button stays disabled on it. `empty` is a gap in
      that person's record — a confirmation letter for somebody with no
      confirmation date — which is a warning, because a letter with a missing
      work location is still a valid letter and blocking on it would make the
      feature unusable.

   3. **Revoking keeps everything.** The letter, its number, its filed copy. So
      the list shows revoked letters rather than hiding them; a company that can
      make a letter it issued disappear has an audit trail worth nothing. */

import { Fragment, useCallback, useState } from 'react'
import { api, openPrintable } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type {
  DirectoryEntry,
  IssuedLetter,
  LetterPreview,
  LetterTemplate,
  RequestableTemplate,
} from '../../../lib/types'
import '../../../styles/letters.css'

export function typeLabel(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

function StatusPill({ letter }: { letter: IssuedLetter }) {
  const tone =
    letter.status === 'issued' ? 'ok' : letter.status === 'revoked' ? 'bad' : 'warn'
  return <span className={`lt-pill lt-pill-${tone}`}>{typeLabel(letter.status)}</span>
}

export default function Letters() {
  const lettersQ = useQuery<IssuedLetter[]>('letters', () =>
    api.get<IssuedLetter[]>('/letters'),
  )
  const templatesQ = useQuery<LetterTemplate[]>('letter-templates', () =>
    api.get<LetterTemplate[]>('/letters/templates?active_only=true'),
  )
  const [error, setError] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)

  const reload = useCallback(() => {
    lettersQ.reload()
    setError(null)
  }, [lettersQ])

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Letters</h1>
          <p className="muted">
            Issue a letter from a template. Once issued the wording is fixed —
            it is the record of what the company said.
          </p>
        </div>
        <button className="btn primary" onClick={() => setComposing((v) => !v)}>
          {composing ? 'Close' : 'New letter'}
        </button>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      {composing && (
        <Compose
          templates={templatesQ.data ?? []}
          onDone={() => {
            setComposing(false)
            reload()
          }}
          onError={setError}
        />
      )}

      {lettersQ.loading ? (
        <Loading />
      ) : lettersQ.error ? (
        <ErrorNote>{lettersQ.error}</ErrorNote>
      ) : !lettersQ.data?.length ? (
        <Empty>No letters yet.</Empty>
      ) : (
        <LetterTable letters={lettersQ.data} onChanged={reload} onError={setError} />
      )}
    </div>
  )
}

function LetterTable({
  letters,
  onChanged,
  onError,
}: {
  letters: IssuedLetter[]
  onChanged: () => void
  onError: (message: string) => void
}) {
  const [open, setOpen] = useState<string | null>(null)

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Reference</th><th>Employee</th><th>Letter</th>
            <th>Issued</th><th>Status</th><th />
          </tr>
        </thead>
        <tbody>
          {letters.map((letter) => (
            <Fragment key={letter.id}>
              <tr>
                <td>{letter.reference_no ?? <span className="muted">—</span>}</td>
                <td>
                  <div className="lt-name">{letter.user_name}</div>
                  {letter.requested_by_name && (
                    <div className="muted">requested by {letter.requested_by_name}</div>
                  )}
                </td>
                <td>
                  {letter.template_name ?? typeLabel(letter.letter_type)}
                  <div className="muted">{typeLabel(letter.letter_type)}</div>
                </td>
                <td>
                  {letter.issued_on ?? <span className="muted">—</span>}
                  {letter.status === 'issued' && !letter.is_filed && (
                    /* Filing is a side effect that may fail. Say so rather than
                       implying every issued letter reached the document file. */
                    <div className="lt-warn">not filed</div>
                  )}
                </td>
                <td><StatusPill letter={letter} /></td>
                <td className="row-actions">
                  <button className="btn small" onClick={() => setOpen(open === letter.id ? null : letter.id)}>
                    {open === letter.id ? 'Hide' : 'View'}
                  </button>
                  <button
                    className="btn small"
                    onClick={() =>
                      openPrintable(`/letters/${letter.id}/print`).catch((caught) =>
                        onError((caught as Error).message),
                      )
                    }
                  >
                    Print
                  </button>
                </td>
              </tr>
              {open === letter.id && (
                <tr>
                  <td colSpan={6}>
                    <LetterDetail letter={letter} onChanged={onChanged} onError={onError} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LetterDetail({
  letter,
  onChanged,
  onError,
}: {
  letter: IssuedLetter
  onChanged: () => void
  onError: (message: string) => void
}) {
  const [body, setBody] = useState(letter.body)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const isDraft = letter.status === 'draft'

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    try {
      await action()
      onChanged()
    } catch (caught) {
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lt-detail">
      {letter.subject && <div className="lt-subject">{letter.subject}</div>}

      {isDraft ? (
        <>
          <textarea
            className="lt-body-edit"
            rows={14}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="lt-actions">
            <button
              className="btn"
              disabled={busy || body === letter.body}
              onClick={() => run(() => api.patch(`/letters/${letter.id}`, { body }))}
            >
              Save draft
            </button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => run(() => api.post(`/letters/${letter.id}/issue`, {}))}
            >
              Issue
            </button>
          </div>
          <p className="muted">
            Issuing allocates a reference number, fixes this wording permanently,
            and files a copy in the employee’s documents.
          </p>
        </>
      ) : (
        <>
          {/* No edit path for an issued letter — not a disabled field. The
              frozen text is the record. */}
          <pre className="lt-body">{letter.body}</pre>
          {letter.status === 'revoked' ? (
            <p className="lt-warn">
              Withdrawn{letter.revoked_by_name ? ` by ${letter.revoked_by_name}` : ''}
              {letter.revoked_at ? ` on ${letter.revoked_at.slice(0, 10)}` : ''}
              {letter.revoked_reason ? ` — ${letter.revoked_reason}` : ''}
            </p>
          ) : (
            <div className="lt-actions">
              <input
                placeholder="Why is this being withdrawn?"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
              <button
                className="btn danger"
                disabled={busy || !reason.trim()}
                onClick={() => run(() => api.post(`/letters/${letter.id}/revoke`, { reason }))}
              >
                Revoke
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* --- compose --------------------------------------------------------------- */

function Compose({
  templates,
  onDone,
  onError,
}: {
  templates: LetterTemplate[]
  onDone: () => void
  onError: (message: string) => void
}) {
  const [templateId, setTemplateId] = useState('')
  const [userId, setUserId] = useState('')
  const [preview, setPreview] = useState<LetterPreview | null>(null)
  const [busy, setBusy] = useState(false)

  const people = useQuery<DirectoryEntry[]>('letters-directory', () =>
    api.get<DirectoryEntry[]>('/people/directory'),
  )

  const ready = Boolean(templateId && userId)

  const load = useCallback(async () => {
    if (!ready) return
    setBusy(true)
    try {
      setPreview(
        await api.get<LetterPreview>(
          `/letters/preview?template_id=${templateId}&user_id=${userId}`,
        ),
      )
    } catch (caught) {
      onError((caught as Error).message)
      setPreview(null)
    } finally {
      setBusy(false)
    }
  }, [ready, templateId, userId, onError])

  async function createDraft() {
    setBusy(true)
    try {
      await api.post('/letters', { template_id: templateId, user_id: userId })
      onDone()
    } catch (caught) {
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card lt-compose">
      <h2 className="card-title">New letter</h2>

      {!templates.length ? (
        <Empty>
          No active templates. Create one under Letter templates, or seed the
          standard five.
        </Empty>
      ) : (
        <>
          <div className="lt-compose-row">
            <label className="lt-field">
              <span className="lt-field-label">Template</span>
              <select
                value={templateId}
                onChange={(event) => {
                  setTemplateId(event.target.value)
                  setPreview(null)
                }}
              >
                <option value="">Choose…</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name} · {typeLabel(template.letter_type)}
                  </option>
                ))}
              </select>
            </label>
            <label className="lt-field">
              <span className="lt-field-label">Employee</span>
              <select
                value={userId}
                onChange={(event) => {
                  setUserId(event.target.value)
                  setPreview(null)
                }}
              >
                <option value="">Choose…</option>
                {(people.data ?? []).map((person) => (
                  <option key={person.user_id} value={person.user_id}>
                    {person.full_name}
                    {person.employee_code ? ` · ${person.employee_code}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn" disabled={!ready || busy} onClick={load}>
              Preview
            </button>
          </div>

          {preview && (
            <div className="lt-preview">
              {preview.unknown.length > 0 && (
                <ErrorNote>
                  This template uses fields that do not exist:{' '}
                  {preview.unknown.join(', ')}. Fix the template first.
                </ErrorNote>
              )}
              {preview.empty.length > 0 && (
                <p className="lt-warn">
                  Blank for this person: {preview.empty.join(', ')}. The letter
                  will have gaps where those appear.
                </p>
              )}
              <pre className="lt-body">{preview.text}</pre>
              <div className="lt-actions">
                <button
                  className="btn primary"
                  disabled={busy || preview.unknown.length > 0}
                  onClick={createDraft}
                >
                  Create draft
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}

/* --- employee self-service ------------------------------------------------- */

/** "My letters" — what has been issued to me, and asking for another.
 *
 *  Drafts are deliberately absent: the server does not send them, because a
 *  draft is HR working out what to say. */
export function MyLetters() {
  const mineQ = useQuery<IssuedLetter[]>('my-letters', () =>
    api.get<IssuedLetter[]>('/letters'),
  )
  const askableQ = useQuery<RequestableTemplate[]>('letters-requestable', () =>
    api.get<RequestableTemplate[]>('/letters/requestable'),
  )
  const [templateId, setTemplateId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asked, setAsked] = useState(false)

  async function ask() {
    setBusy(true)
    setError(null)
    try {
      await api.post('/letters/request', { template_id: templateId, note: note || null })
      setAsked(true)
      setNote('')
      setTemplateId('')
      mineQ.reload()
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
          <h1>My letters</h1>
          <p className="muted">Letters issued to you, and requests for another.</p>
        </div>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}
      {asked && (
        <p className="ok-note">
          Requested. HR will review the wording before it is issued.
        </p>
      )}

      {(askableQ.data ?? []).length > 0 && (
        <section className="card lt-compose">
          <h2 className="card-title">Request a letter</h2>
          <div className="lt-compose-row">
            <label className="lt-field">
              <span className="lt-field-label">Letter</span>
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">Choose…</option>
                {(askableQ.data ?? []).map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="lt-field lt-field-wide">
              <span className="lt-field-label">What is it for?</span>
              <input value={note} onChange={(e) => setNote(e.target.value)}
                     placeholder="e.g. a visa application" />
            </label>
            <button className="btn primary" disabled={!templateId || busy} onClick={ask}>
              {busy ? 'Requesting…' : 'Request'}
            </button>
          </div>
        </section>
      )}

      {mineQ.loading ? (
        <Loading />
      ) : mineQ.error ? (
        <ErrorNote>{mineQ.error}</ErrorNote>
      ) : !mineQ.data?.length ? (
        <Empty>No letters have been issued to you yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Reference</th><th>Letter</th><th>Issued</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {mineQ.data.map((letter) => (
                <tr key={letter.id}>
                  <td>{letter.reference_no ?? '—'}</td>
                  <td>{letter.template_name ?? typeLabel(letter.letter_type)}</td>
                  <td>{letter.issued_on ?? '—'}</td>
                  <td><StatusPill letter={letter} /></td>
                  <td className="row-actions">
                    <button
                      className="btn small"
                      onClick={() =>
                        openPrintable(`/letters/${letter.id}/print`).catch((caught) =>
                          setError((caught as Error).message),
                        )
                      }
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
