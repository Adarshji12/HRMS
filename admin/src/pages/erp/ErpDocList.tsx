/**
 * The list page for Sale Return and Quotation, laid out like the Sale list:
 * a tab strip, title with search on the left, Filters (the dates live there),
 * Export, Columns and New, then the table and a details strip.
 */

import { useEffect, useMemo, useState } from 'react'
import { Loading, ErrorNote } from '../../components/ui'
import { IconChevronDown, IconDownload, IconFilter, IconFolder, IconPlus, IconSearch } from '../../components/Icons'
import { downloadCsv } from '../../lib/sheet'
import { ColumnSettings, useColumns, type ColumnDef } from '../../components/ViewSettings'
import { Dialog } from '../crm/parts'
import { todayISO } from '../crm/api'
import { rupees, type SaleBill } from './api'
import { DateText } from './parts'
import '../../styles/sale-list.css'

const PAGE_SIZE = 14
const firstOfMonth = () => `${todayISO().slice(0, 8)}01`
const dash = <span className="sl-dim">—</span>

type Col = ColumnDef & { td: (b: SaleBill, index: number) => React.ReactNode; className?: string; thClass?: string }

export default function ErpDocList({ kind, word, rows, loading, error, canNew, onNew, onOpen }: {
  kind: 'quotation' | 'return' | 'issue'
  word: string
  rows: SaleBill[]
  loading: boolean
  error: string | null
  canNew: boolean
  onNew: () => void
  onOpen: (b: SaleBill) => void
}) {
  const ret = kind === 'return'
  const issue = kind === 'issue'
  const [q, setQ] = useState('')
  const [from, setFrom] = useState(firstOfMonth)
  const [to, setTo] = useState(todayISO)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [page, setPage] = useState(0)
  const [cursor, setCursor] = useState(0)

  const COLUMNS: Col[] = useMemo(() => [
    { key: 'no', label: '#', thClass: 'sl-c', className: 'sl-c sl-dim', td: (_b, i) => <>{i}</> },
    { key: 'number', label: 'No.', locked: true, td: (b) => <span className="sl-link">{b.number}</span> },
    { key: 'date', label: 'Date', td: (b) => <DateText iso={b.bill_date} /> },
    { key: 'party', label: issue ? 'Issued to' : 'Party', className: 'sl-party', td: (b) => <>{b.party_name}</> },
    ...(issue ? [
      { key: 'store', label: 'Store', td: (b: SaleBill) => <>{b.warehouse_name ?? dash}</> },
      { key: 'narration', label: 'Narration', td: (b: SaleBill) => <>{b.notes ?? dash}</> },
    ] : [
      { key: 'station', label: 'Station', td: (b: SaleBill) => <>{b.station ?? dash}</> },
      { key: 'mobile', label: 'Mobile', className: 'sl-mono', td: (b: SaleBill) => <>{b.mobile ?? dash}</> },
    ]),
    ...(issue ? [] : [
    ret
      ? { key: 'against', label: 'Against Bill', td: (b: SaleBill) => <>{b.against_number ?? dash}</> }
      : { key: 'valid', label: 'Valid till', td: (b: SaleBill) => <>{b.valid_till ? <DateText iso={b.valid_till} /> : dash}</> },
    { key: 'taxable', label: 'Taxable', thClass: 'sl-r', className: 'sl-r', td: (b: SaleBill) => <>{rupees(b.sub_total)}</> },
    { key: 'gst', label: 'GST', thClass: 'sl-r', className: 'sl-r', td: (b: SaleBill) => <>{rupees(b.tax_total)}</> },
    ]),
    { key: 'net', label: issue ? 'Value' : 'Net Amount', thClass: 'sl-r', className: 'sl-r sl-strong', td: (b) => <>{rupees(b.grand_total)}</> },
    { key: 'status', label: 'Status', td: (b) => <span className="sl-pill sl-pill-warn">{b.status === 'open' ? 'Open' : b.status}</span> },
  ] as Col[], [ret, issue])
  const columns = useColumns(`erp-${kind}-list`, COLUMNS)

  const needle = q.trim().toLowerCase()
  const shown = rows.filter((b) => (!from || b.bill_date >= from) && (!to || b.bill_date <= to)
    && (!needle || [b.number, b.party_name, b.against_number, b.notes].some((x) => x && x.toLowerCase().includes(needle))))
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))
  const safePage = Math.min(page, pages - 1)
  const pageRows = shown.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)
  const current = pageRows[Math.min(cursor, Math.max(0, pageRows.length - 1))] ?? null
  const dateChanged = from !== firstOfMonth() || to !== todayISO()
  useEffect(() => { setPage(0); setCursor(0) }, [from, to, q])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (filtersOpen) return
      const t = e.target as HTMLElement
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
      if (e.key === 'F2' && canNew) { e.preventDefault(); onNew() }
      else if (!typing && e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, pageRows.length - 1)) }
      else if (!typing && e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)) }
      else if (!typing && e.key === 'Enter' && current) { e.preventDefault(); onOpen(current) }
      else if (!typing && e.key === 'PageDown') { e.preventDefault(); setPage(Math.min(safePage + 1, pages - 1)); setCursor(0) }
      else if (!typing && e.key === 'PageUp') { e.preventDefault(); setPage(Math.max(safePage - 1, 0)); setCursor(0) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function exportRows() {
    downloadCsv(`${kind}-${from || 'start'}-to-${to || 'today'}.csv`,
      ['No.', 'Date', 'Party', 'Station', 'Mobile', ret ? 'Against bill' : 'Valid till', 'Taxable', 'GST', 'Net amount', 'Status'],
      shown.map((b) => [b.number, b.bill_date, b.party_name, b.station ?? '', b.mobile ?? '', (ret ? b.against_number : b.valid_till) ?? '', b.sub_total, b.tax_total, b.grand_total, b.status ?? '']))
  }

  return (
    <div className="sl">
      <div className="sl-tabs" role="tablist">
        <button role="tab" aria-selected className="sl-tab is-on"><IconFolder size={15} /> {word}</button>
        <button type="button" className="sl-newwin" onClick={() => window.open(window.location.href, '_blank')}>
          <IconPlus size={14} /> New Window <IconChevronDown size={12} />
        </button>
      </div>

      <div className="sl-bar">
        <h1 className="sl-title">{word}</h1>
        <label className="sl-search">
          <IconSearch size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="No. or party" aria-label={`Search ${word}`} />
        </label>
        <div className="sl-tools">
          <button type="button" className={`sl-btn${filtersOpen ? ' is-on' : ''}`} onClick={() => setFiltersOpen(true)}>
            <IconFilter size={14} /> Filters{dateChanged && <span className="sl-count">1</span>}
          </button>
          <button aria-label="Export" title="Export" type="button" className="sl-btn" onClick={exportRows} disabled={shown.length === 0}><IconDownload size={14} /></button>
          <ColumnSettings defs={COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden} onSave={columns.save} onReset={columns.reset} />
          {canNew && <button type="button" className="sl-btn sl-btn-primary" onClick={onNew}><IconPlus size={14} /> New <kbd>F2</kbd></button>}
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="sl-table-wrap">
        <table className="sl-table">
          <thead><tr>{columns.visible.map((c) => <th key={c.key} className={(c as Col).thClass}>{c.label}</th>)}</tr></thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={columns.visible.length} className="sl-empty"><Loading /></td></tr>
            ) : pageRows.length === 0 ? (
              <tr><td colSpan={columns.visible.length} className="sl-empty">No {ret ? 'sale returns' : issue ? 'stock issues' : 'quotations'} in this period.{canNew && <> Press <kbd>F2</kbd> for a new {ret ? 'sale return' : issue ? 'stock issue' : 'quotation'}.</>}</td></tr>
            ) : pageRows.map((b, index) => (
              <tr key={b.id} className={index === cursor ? 'is-cur' : undefined} onClick={() => setCursor(index)} onDoubleClick={() => onOpen(b)} aria-selected={index === cursor}>
                {columns.visible.map((c) => { const col = c as Col; return <td key={col.key} className={col.className}>{col.td(b, safePage * PAGE_SIZE + index + 1)}</td> })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="sl-details">
        <section>
          <h2>{word} details</h2>
          <dl><dt>No. of {ret ? 'returns' : issue ? 'stock issues' : 'quotations'}</dt><dd>{shown.length}</dd><dt>Party</dt><dd>{current?.party_name ?? '—'}</dd><dt>Date</dt><dd>{current ? <DateText iso={current.bill_date} /> : '—'}</dd></dl>
        </section>
        <section>
          <h2>Amounts</h2>
          <dl><dt>Taxable</dt><dd>{current ? rupees(current.sub_total) : '—'}</dd><dt>GST</dt><dd>{current ? rupees(current.tax_total) : '—'}</dd><dt>Net amount</dt><dd>{current ? rupees(current.grand_total) : '—'}</dd></dl>
        </section>
        <section>
          <h2>Other details</h2>
          <dl><dt>{ret ? 'Against bill' : 'Valid till'}</dt><dd>{current ? ((ret ? current.against_number : current.valid_till) ?? '—') : '—'}</dd><dt>Station</dt><dd>{current?.station ?? '—'}</dd><dt>Mobile</dt><dd>{current?.mobile ?? '—'}</dd></dl>
        </section>
      </div>

      <div className="sl-keys">
        <span><kbd>↑</kbd><kbd>↓</kbd> Move</span>
        <span><kbd>Enter</kbd> Open</span>
        {canNew && <span><kbd>F2</kbd> New</span>}
        <span><kbd>PgUp</kbd> / <kbd>PgDn</kbd> Page {safePage + 1} of {pages}</span>
      </div>

      {filtersOpen && <DateFilter from={from} to={to} onClose={() => setFiltersOpen(false)} onApply={(f, t) => { setFrom(f); setTo(t); setFiltersOpen(false) }} />}
    </div>
  )
}

function DateFilter({ from, to, onClose, onApply }: { from: string; to: string; onClose: () => void; onApply: (f: string, t: string) => void }) {
  const [a, setA] = useState(from)
  const [b, setB] = useState(to)
  return (
    <Dialog title="Filters" onClose={onClose}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Close</button>
        <button type="button" className="btn" onClick={() => onApply(firstOfMonth(), todayISO())}>Reset</button>
        <button type="button" className="btn btn-primary" onClick={() => onApply(a, b)}>Submit</button>
      </>}>
      <form className="sl-fd" onSubmit={(e) => { e.preventDefault(); onApply(a, b) }}>
        <div className="sl-fd-row"><span>Date From</span>
          <div className="sl-fd-pair">
            <input type="date" value={a} max={b || undefined} aria-label="From date" onChange={(e) => setA(e.target.value)} autoFocus />
            <span>Date To</span>
            <input type="date" value={b} min={a || undefined} aria-label="To date" onChange={(e) => setB(e.target.value)} />
          </div>
        </div>
      </form>
    </Dialog>
  )
}
