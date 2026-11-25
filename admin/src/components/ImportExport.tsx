/**
 * Import and Export buttons for a list page.
 *
 * Export writes the rows the list is showing (so a filtered list exports the
 * filtered rows) as a CSV that opens in Excel. Import reads a CSV with a header
 * row, creates the rows one at a time through the page's own save call, and
 * reports which rows failed and why — so the same rules the form enforces apply
 * to an import, and one bad row never blocks the good ones.
 */

import { useState } from 'react'
import { Dialog } from '../pages/crm/parts'
import { splitCsvLine } from '../pages/crm/MyLeads'
import { downloadCsv, type Cell } from '../lib/sheet'

export interface IoColumn<T> {
  /** The key the import hands to `build`. */
  key: string
  /** The CSV heading, in both the export and the import template. */
  label: string
  /** The value in the export. */
  get: (row: T) => Cell
  /** An example cell for the template. */
  sample?: string
  /** An import row without it is rejected. */
  required?: boolean
}

const Arrow = ({ up }: { up?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {up ? <path d="M12 3v12M7 10l5 5 5-5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" /> : <path d="M12 15V3M7 8l5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />}
  </svg>
)

export default function ImportExport<T>({
  name, columns, rows, build, save, onDone, canImport = true,
}: {
  /** File name stem and the word used in messages, e.g. "items". */
  name: string
  columns: IoColumn<T>[]
  rows: T[]
  /** Turns one CSV row (keyed by column key) into the body to save; throw to reject the row. */
  build: (record: Record<string, string>) => Record<string, unknown>
  save: (body: Record<string, unknown>) => Promise<unknown>
  onDone: () => void
  canImport?: boolean
}) {
  const [open, setOpen] = useState(false)
  function exportRows() {
    downloadCsv(`${name}-${new Date().toISOString().slice(0, 10)}.csv`, columns.map((c) => c.label),
      rows.map((r) => columns.map((c) => c.get(r))))
  }

  return (
    <>
      {canImport && (
        <button type="button" className="btn vw-refresh" onClick={() => setOpen(true)} title={`Import ${name} from a CSV file`} aria-label={`Import ${name}`}>
          <Arrow up />
        </button>
      )}
      <button type="button" className="btn vw-refresh" onClick={exportRows} disabled={rows.length === 0} aria-label={`Export ${name}`}
              title={rows.length ? `Download ${rows.length} ${name} as CSV` : `No ${name} to export`}>
        <Arrow />
      </button>
      {open && (
        <ImportDialog name={name} columns={columns} build={build} save={save}
                      onClose={() => setOpen(false)} onDone={() => { setOpen(false); onDone() }} />
      )}
    </>
  )
}

function ImportDialog<T>({ name, columns, build, save, onClose, onDone }: {
  name: string
  columns: IoColumn<T>[]
  build: (record: Record<string, string>) => Record<string, unknown>
  save: (body: Record<string, unknown>) => Promise<unknown>
  onClose: () => void
  onDone: () => void
}) {
  const [records, setRecords] = useState<Array<Record<string, string>>>([])
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failed, setFailed] = useState<string[]>([])
  const [created, setCreated] = useState<number | null>(null)

  function template() {
    downloadCsv(`${name}-import-template.csv`, columns.map((c) => c.label), [columns.map((c) => c.sample ?? '')])
  }

  async function readFile(file: File) {
    setError(null); setFailed([]); setCreated(null)
    const lines = (await file.text()).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim())
    if (lines.length < 2) { setError('That file has a header but no rows.'); setRecords([]); return }
    const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/\s*\*$/, ''))
    const index = new Map<string, number>()
    columns.forEach((c) => {
      const at = header.findIndex((h) => h === c.label.toLowerCase() || h === c.key.toLowerCase())
      if (at >= 0) index.set(c.key, at)
    })
    const missing = columns.filter((c) => c.required && !index.has(c.key)).map((c) => c.label)
    if (missing.length) { setError(`The file has no “${missing.join('”, “')}” column. Download the template to see the layout.`); setRecords([]); return }
    setFileName(file.name)
    setRecords(lines.slice(1).map((line) => {
      const cells = splitCsvLine(line)
      const rec: Record<string, string> = {}
      index.forEach((at, key) => { rec[key] = (cells[at] ?? '').trim() })
      return rec
    }))
  }

  async function run() {
    setBusy(true); setError(null)
    const problems: string[] = []
    let ok = 0
    for (let i = 0; i < records.length; i++) {
      const rec = records[i]
      const line = i + 2 // the header is line 1
      try {
        const lacking = columns.filter((c) => c.required && !rec[c.key])
        if (lacking.length) throw new Error(`${lacking.map((c) => c.label).join(', ')} is required`)
        await save(build(rec))
        ok++
      } catch (err) {
        problems.push(`Row ${line}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    setBusy(false); setCreated(ok); setFailed(problems)
    if (!problems.length) onDone()
  }

  return (
    <Dialog title={`Import ${name}`} medium onClose={created !== null && created > 0 ? onDone : onClose}
            subtitle={`A CSV with a header row. ${columns.filter((c) => c.required).map((c) => c.label).join(', ')} ${columns.filter((c) => c.required).length === 1 ? 'is' : 'are'} required.`}
            footer={<>
              {created !== null && created > 0
                ? <button className="btn btn-primary" onClick={onDone}>Done</button>
                : <>
                    <button className="btn" onClick={onClose}>Cancel</button>
                    <button className="btn btn-primary" onClick={() => void run()} disabled={busy || records.length === 0}>
                      {busy ? 'Importing…' : `Import ${records.length || ''} ${name}`.replace('  ', ' ')}
                    </button>
                  </>}
            </>}>
      <div style={{ display: 'grid', gap: 14, padding: '8px 24px 20px' }}>
        <div>
          <input type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f) }} />
          <p className="muted-sm" style={{ margin: '8px 0 0' }}>
            Not sure of the layout?{' '}
            <button type="button" className="vw-link" onClick={template}>Download the template</button>
          </p>
        </div>
        {fileName && records.length > 0 && created === null && (
          <p className="muted-sm" style={{ margin: 0 }}><b>{records.length}</b> row{records.length === 1 ? '' : 's'} found in {fileName}.</p>
        )}
        {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
        {created !== null && (
          <p style={{ margin: 0 }}>
            <b>{created}</b> imported{failed.length ? `, ${failed.length} not imported:` : '.'}
          </p>
        )}
        {failed.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 180, overflow: 'auto', color: '#dc2626', fontSize: 13 }}>
            {failed.map((f) => <li key={f}>{f}</li>)}
          </ul>
        )}
      </div>
    </Dialog>
  )
}
