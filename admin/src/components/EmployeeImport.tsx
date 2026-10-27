import { useRef, useState } from 'react'
import { api, download } from '../lib/api'
import { Dialog } from '../pages/crm/parts'
import { ErrorNote } from './ui'
import { IconCheck, IconDownload, IconSheet, IconUpload } from './Icons'
import '../styles/crm.css'

/* Import employees from the sample Excel file.
 *
 * Three steps in one dialog: choose a file (with the sample one link away),
 * check it — the server reads every row and says which are ready and what is
 * wrong with the rest, writing nothing — and import, which creates only the
 * ready rows. The check is not optional: a spreadsheet of forty people with
 * three bad rows should say so before anybody is created, not after.
 */

interface ImportRow {
  row: number
  name: string
  email: string
  state: 'ready' | 'error' | 'skipped' | 'created'
  messages: string[]
}

interface ImportResult {
  rows: ImportRow[]
  ready: number
  errors: number
  skipped: number
  created: number
}

const STATE_LABEL: Record<ImportRow['state'], string> = {
  ready: 'Ready', error: 'Needs fixing', skipped: 'Skipped', created: 'Imported',
}

export default function EmployeeImport({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [checked, setChecked] = useState<ImportResult | null>(null)
  const [done, setDone] = useState<ImportResult | null>(null)
  const [busy, setBusy] = useState<'sample' | 'check' | 'import' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function send(commit: boolean) {
    if (!file) return
    setBusy(commit ? 'import' : 'check')
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const result = await api.upload<ImportResult>(`/admin/employees/import?commit=${commit}`, form)
      if (commit) {
        setDone(result)
        if (result.created > 0) onImported()
      } else {
        setChecked(result)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That file could not be read.')
    } finally {
      setBusy(null)
    }
  }

  async function sample() {
    setBusy('sample')
    setError(null)
    try {
      await download('/admin/employees/template.xlsx', 'employees-import-sample.xlsx')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The sample file could not be downloaded.')
    } finally {
      setBusy(null)
    }
  }

  function pick(next: File | null) {
    setFile(next)
    setChecked(null)
    setDone(null)
    setError(null)
  }

  const result = done ?? checked
  const footer = done ? (
    <button className="btn btn-primary" onClick={onClose}>Done</button>
  ) : checked ? (
    <>
      <button className="btn" onClick={() => { pick(null); input.current?.click() }}>Choose another file</button>
      <button className="btn btn-primary" disabled={busy !== null || checked.ready === 0} onClick={() => void send(true)}>
        {busy === 'import' ? 'Importing…' : `Import ${checked.ready} employee${checked.ready === 1 ? '' : 's'}`}
      </button>
    </>
  ) : (
    <>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!file || busy !== null} onClick={() => void send(false)}>
        {busy === 'check' ? 'Checking…' : 'Check file'}
      </button>
    </>
  )

  return (
    <div className="crm">
      <Dialog
        title="Import employees"
        subtitle="Fill the sample Excel file, then upload it. Every row is checked before anything is saved."
        onClose={onClose}
        footer={footer}
        wide
      >
        <div className="ei">
          {error && <ErrorNote>{error}</ErrorNote>}

          {!done && (
            <div className="ei-steps">
              <div className="ei-step">
                <span className="ei-step-num">1</span>
                <div className="ei-step-body">
                  <b>Download the sample file</b>
                  <span>Its drop-downs list your departments, designations, teams and roles.</span>
                </div>
                <button className="btn btn-sm" disabled={busy === 'sample'} onClick={() => void sample()}>
                  <IconDownload size={14} /> {busy === 'sample' ? 'Preparing…' : 'Sample file'}
                </button>
              </div>
              <div className="ei-step">
                <span className="ei-step-num">2</span>
                <div className="ei-step-body">
                  <b>Choose the filled file</b>
                  <span>{file ? file.name : '.xlsx from the sample, or a .csv with the same columns.'}</span>
                </div>
                <button className="btn btn-sm" onClick={() => input.current?.click()}>
                  <IconUpload size={14} /> {file ? 'Change' : 'Choose file'}
                </button>
                <input
                  ref={input}
                  type="file"
                  accept=".xlsx,.xlsm,.csv"
                  hidden
                  onChange={(e) => pick(e.target.files?.[0] ?? null)}
                />
              </div>
            </div>
          )}

          {result && (
            <>
              <div className="ei-summary">
                {done ? (
                  <span className={`ei-chip ${done.created ? 'is-good' : 'is-bad'}`}>
                    <IconCheck size={14} /> {done.created} imported
                  </span>
                ) : (
                  <span className="ei-chip is-good">{result.ready} ready</span>
                )}
                {result.errors > 0 && <span className="ei-chip is-bad">{result.errors} need fixing</span>}
                {result.skipped > 0 && <span className="ei-chip">{result.skipped} skipped</span>}
                <span className="ei-summary-note">
                  {done
                    ? done.errors ? 'Fix the rows below in the file and import it again — the imported ones will show as already existing.' : 'Everyone in the file is now on the Employees list.'
                    : result.errors ? 'Rows that need fixing are left out. Fix them in the file and check again, or import the ready ones now.' : 'Nothing has been saved yet.'}
                </span>
              </div>

              <div className="ei-table table-wrap">
                <table>
                  <thead>
                    <tr><th>Row</th><th>Name</th><th>Work email</th><th>Status</th><th>Details</th></tr>
                  </thead>
                  <tbody>
                    {result.rows.map((r) => (
                      <tr key={r.row} className={`is-${r.state}`}>
                        <td className="crm-sub">{r.row}</td>
                        <td className="crm-strong">{r.name || <span className="crm-muted">—</span>}</td>
                        <td>{r.email || <span className="crm-muted">—</span>}</td>
                        <td><span className={`ei-state is-${r.state}`}>{STATE_LABEL[r.state]}</span></td>
                        <td className="ei-msg">
                          {r.messages.length ? (
                            <ul>{r.messages.map((m) => <li key={m}>{m}</li>)}</ul>
                          ) : <span className="crm-muted">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!result && !file && (
            <div className="ei-hint">
              <IconSheet size={16} />
              <span>
                Required: <b>First name</b> and <b>Work email</b>. Leave Employee ID blank to issue IDs
                from HR Settings. Up to 1,000 employees per file.
              </span>
            </div>
          )}
        </div>
      </Dialog>
    </div>
  )
}
