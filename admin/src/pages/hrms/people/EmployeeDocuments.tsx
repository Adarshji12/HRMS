/* One person's document file — upload, list, verify, download, delete.

   Deliberately not the onboarding document list. That one belongs to a
   checklist and is archived with it; this belongs to the person and outlives
   every checklist they will have, which is why a PAN card filed here survives
   HR tidying up a joining list.

   Two server truths:

   1. **The storage key never reaches the client.** Download goes through
      `GET /people/documents/{id}/file`, which re-checks the permission on every
      request. A link built from a key would skip exactly that check.

   2. **Verify and delete are administrator-only, even for the subject.**
      Verification means somebody at the company looked at the original, and an
      employee deleting their own signed acknowledgement is what a document file
      exists to prevent. The buttons are hidden accordingly — the server refuses
      regardless, so this is tidiness, not the guard. */

import { useCallback, useRef, useState } from 'react'
import { api, download } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type { EmployeeDocument } from '../../../lib/types'
import '../../../styles/people.css'

const DOC_TYPES = [
  'pan_card', 'aadhaar_card', 'passport', 'visa', 'offer_letter', 'contract',
  'degree_certificate', 'experience_letter', 'bank_proof', 'policy_ack', 'other',
]

function label(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Expiry, worded from the server's `days_to_expiry` so the list, the tile and
 *  the report cannot disagree about what "soon" means. */
function expiry(doc: EmployeeDocument): { text: string; tone: string } | null {
  if (doc.days_to_expiry === null) return null
  if (doc.days_to_expiry < 0) return { text: `Expired ${-doc.days_to_expiry}d ago`, tone: 'bad' }
  if (doc.days_to_expiry <= 30) return { text: `Expires in ${doc.days_to_expiry}d`, tone: 'warn' }
  return { text: `Expires ${doc.expires_on}`, tone: 'muted' }
}

export default function EmployeeDocuments({
  userId,
  canManage,
}: {
  userId: string
  canManage: boolean
}) {
  const docsQ = useQuery<EmployeeDocument[]>(`docs-${userId}`, () =>
    api.get<EmployeeDocument[]>(`/people/${userId}/documents`),
  )
  const [error, setError] = useState<string | null>(null)

  const act = useCallback(
    async (run: () => Promise<unknown>) => {
      setError(null)
      try {
        await run()
        docsQ.reload()
      } catch (caught) {
        setError((caught as Error).message)
      }
    },
    [docsQ],
  )

  /* `download` from lib/api, not an <a href>: the route needs the
     Authorization and tenant headers, and a plain link arrives without them and
     401s. The helper already exists for report exports — a second
     implementation here would be a second place to forget the tenant header. */
  const fetchFile = useCallback(async (doc: EmployeeDocument) => {
    setError(null)
    try {
      await download(`/people/documents/${doc.id}/file`, doc.file_name || doc.doc_type)
    } catch (caught) {
      setError((caught as Error).message)
    }
  }, [])

  return (
    <section className="card hr-section hr-section-wide">
      <h2 className="card-title">Documents</h2>
      {error && <ErrorNote>{error}</ErrorNote>}

      <UploadRow userId={userId} onUploaded={docsQ.reload} onError={setError} />

      {docsQ.loading ? (
        <Loading />
      ) : docsQ.error ? (
        <ErrorNote>{docsQ.error}</ErrorNote>
      ) : !docsQ.data?.length ? (
        <Empty>Nothing on file yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Document</th><th>Issued</th><th>Expiry</th>
                <th>Verified</th><th className="num">Size</th><th />
              </tr>
            </thead>
            <tbody>
              {docsQ.data.map((doc) => {
                const exp = expiry(doc)
                return (
                  <tr key={doc.id}>
                    <td>
                      <div className="hr-doc-name">{doc.title || label(doc.doc_type)}</div>
                      <div className="muted">
                        {label(doc.doc_type)}
                        {doc.uploaded_by_name ? ` · added by ${doc.uploaded_by_name}` : ''}
                      </div>
                    </td>
                    <td>{doc.issued_on ?? '—'}</td>
                    <td>{exp ? <span className={`hr-${exp.tone}`}>{exp.text}</span> : '—'}</td>
                    <td>
                      {doc.is_verified
                        ? <span className="hr-ok">Yes{doc.verified_by_name ? ` · ${doc.verified_by_name}` : ''}</span>
                        : <span className="muted">No</span>}
                    </td>
                    <td className="num">{size(doc.file_size)}</td>
                    <td className="row-actions">
                      <button className="btn small" onClick={() => fetchFile(doc)}>Download</button>
                      {canManage && (
                        <>
                          <button
                            className="btn small"
                            onClick={() => act(() =>
                              api.post(`/people/documents/${doc.id}/verify`, {
                                is_verified: !doc.is_verified,
                              }))}
                          >
                            {doc.is_verified ? 'Unverify' : 'Verify'}
                          </button>
                          <button
                            className="btn small danger"
                            onClick={() => act(() => api.del(`/people/documents/${doc.id}`))}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function UploadRow({
  userId,
  onUploaded,
  onError,
}: {
  userId: string
  onUploaded: () => void
  onError: (message: string) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [docType, setDocType] = useState(DOC_TYPES[0])
  const [title, setTitle] = useState('')
  const [issued, setIssued] = useState('')
  const [expires, setExpires] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    const file = fileRef.current?.files?.[0]
    if (!file) {
      onError('Choose a file first.')
      return
    }
    setBusy(true)
    try {
      const form = new FormData()
      // One JSON blob rather than a form field per attribute — the same shape
      // the onboarding and screenshot uploads use, so the metadata is validated
      // by a Pydantic model and adding a field later does not change the wire
      // format.
      form.append('meta', JSON.stringify({
        doc_type: docType,
        title: title || null,
        issued_on: issued || null,
        expires_on: expires || null,
      }))
      form.append('file', file)
      await api.upload(`/people/${userId}/documents`, form)
      setTitle('')
      setIssued('')
      setExpires('')
      if (fileRef.current) fileRef.current.value = ''
      onUploaded()
    } catch (caught) {
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hr-upload">
      <select value={docType} onChange={(e) => setDocType(e.target.value)} aria-label="Document type">
        {DOC_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
      </select>
      <input placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input type="date" value={issued} onChange={(e) => setIssued(e.target.value)}
             aria-label="Issued on" title="Issued on" />
      <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)}
             aria-label="Expires on" title="Expires on" />
      <input type="file" ref={fileRef} aria-label="File" />
      <button className="btn primary" onClick={submit} disabled={busy}>
        {busy ? 'Uploading…' : 'Upload'}
      </button>
    </div>
  )
}
