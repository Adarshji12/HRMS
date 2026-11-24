/* What the printed invoice shows, and how: paper, colour and which parts print.
 * Kept in this browser (one set for every sale invoice) and applied to the
 * sheet as it is chosen, so the sheet behind the drawer is the live preview. */

import { useState } from 'react'
import { IconClose } from '../../components/Icons'

export const PAPERS = [
  { key: 'a4', label: 'A4', note: 'Default', size: 'A4', width: '210mm', dims: 'A4 · Portrait · 210 × 297 mm' },
  { key: 'a4l', label: 'A4 Landscape', note: '', size: 'A4 landscape', width: '297mm', dims: 'A4 · Landscape · 297 × 210 mm' },
  { key: 'a5', label: 'A5', note: '', size: 'A5', width: '148mm', dims: 'A5 · Portrait · 148 × 210 mm' },
  { key: 'half', label: 'Half Page', note: '', size: '210mm 148mm', width: '210mm', dims: 'Half page · 210 × 148 mm' },
  { key: 't3', label: 'Thermal 3"', note: '', size: '80mm auto', width: '80mm', dims: 'Thermal 3" · 80 mm roll' },
  { key: 't2', label: 'Thermal 2"', note: '', size: '58mm auto', width: '58mm', dims: 'Thermal 2" · 58 mm roll' },
] as const

export const COLOURS = ['#192A60', '#0e7490', '#15803d', '#c2570c', '#b91c1c', '#6d28d9', '#be185d', '#334155']

export interface PrintSettings {
  paper: (typeof PAPERS)[number]['key']
  accent: string
  font: 'default' | 'arial' | 'georgia'
  border: boolean
  title: string
  // header
  logo: boolean; address: boolean; contact: boolean; gstin: boolean; pan: boolean
  custGstin: boolean; shipTo: boolean; dueDate: boolean; supply: boolean; transport: boolean
  // items
  hsn: boolean; discount: boolean; taxCols: boolean; itemCode: boolean
  // footer
  hsnSummary: boolean; words: boolean; bank: boolean; notes: boolean; terms: boolean; signatory: boolean
  receiver: boolean; computerLine: boolean; received: boolean
  signLabel: string
}

export const DEFAULT_PRINT: PrintSettings = {
  paper: 'a4', accent: COLOURS[0], font: 'default', border: true, title: '',
  logo: true, address: true, contact: true, gstin: true, pan: false, custGstin: true, shipTo: true, dueDate: true, supply: true, transport: true,
  hsn: true, discount: true, taxCols: true, itemCode: true,
  hsnSummary: true, words: true, bank: true, notes: true, terms: true, signatory: true, receiver: false, computerLine: true, received: false,
  signLabel: '',
}

const KEY = 'print:sale-invoice'

export function loadPrint(): PrintSettings {
  try { return { ...DEFAULT_PRINT, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } } catch { return DEFAULT_PRINT }
}
export function savePrint(p: PrintSettings | null) {
  try { if (p) localStorage.setItem(KEY, JSON.stringify(p)); else localStorage.removeItem(KEY) } catch { /* private window */ }
}

type TabKey = 'header' | 'items' | 'footer' | 'style'
type Flag = { [K in keyof PrintSettings]: PrintSettings[K] extends boolean ? K : never }[keyof PrintSettings]

export function PrintSettingsDrawer({ value, onChange, onClose }: { value: PrintSettings; onChange: (p: PrintSettings) => void; onClose: () => void }) {
  const [tab, setTab] = useState<TabKey>('header')
  const [draft, setDraft] = useState(value)
  const set = (patch: Partial<PrintSettings>) => { const next = { ...draft, ...patch }; setDraft(next); onChange(next) }
  const toggle = (key: Flag, label: string, hint?: string) => (
    <label key={key} className={`ps-toggle${draft[key] ? ' is-on' : ''}`}>
      <span>{label}{hint && <small>{hint}</small>}</span>
      <input type="checkbox" checked={draft[key]} onChange={(e) => set({ [key]: e.target.checked } as Partial<PrintSettings>)} />
      <i aria-hidden />
    </label>
  )
  const tabs: Array<[TabKey, string]> = [['header', 'Header'], ['items', 'Items'], ['footer', 'Footer'], ['style', 'Style']]
  return (
    <aside className="ps-drawer" aria-label="Print settings">
      <div className="ps-top"><b>Print settings</b><button type="button" className="btn btn-sm" onClick={onClose} aria-label="Close settings"><IconClose size={14} /></button></div>
      <div className="ps-row">
        <label>Document<select disabled><option>Sale Invoice</option></select></label>
        <label>Paper<select value={draft.paper} onChange={(e) => set({ paper: e.target.value as PrintSettings['paper'] })}>
          {PAPERS.map((p) => <option key={p.key} value={p.key}>{p.label}{p.note ? ` (${p.note.toLowerCase()})` : ''}</option>)}</select></label>
      </div>
      <div className="ps-tabs">{tabs.map(([k, l]) => <button key={k} type="button" className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div className="ps-body">
        {tab === 'header' && <>
          <label className="ps-field">Document title<input value={draft.title} placeholder="Tax Invoice" onChange={(e) => set({ title: e.target.value })} /></label>
          <h5>Your company</h5>
          <div className="ps-grid">{toggle('logo', 'Logo')}{toggle('address', 'Address')}{toggle('contact', 'Phone & email')}{toggle('gstin', 'GSTIN')}{toggle('pan', 'PAN')}</div>
          <h5>Customer &amp; bill details</h5>
          <div className="ps-grid">{toggle('custGstin', 'Customer GSTIN')}{toggle('shipTo', 'Ship-to address')}{toggle('dueDate', 'Due date')}{toggle('supply', 'Place of supply')}{toggle('transport', 'Transport & vehicle')}</div>
        </>}
        {tab === 'items' && <>
          <h5>Columns</h5>
          <p className="muted-sm"># and Item description always print.</p>
          <div className="ps-grid">{toggle('hsn', 'HSN / SAC')}{toggle('discount', 'Discount', 'only when a line has one')}{toggle('taxCols', 'GST columns', 'GST %, CGST, SGST / IGST')}</div>
          <h5>Under the item name</h5>
          <div className="ps-grid">{toggle('itemCode', 'Item code')}</div>
        </>}
        {tab === 'footer' && <>
          <h5>Below the items</h5>
          <div className="ps-grid">{toggle('hsnSummary', 'HSN tax summary')}{toggle('words', 'Amount in words')}{toggle('bank', 'Bank details')}{toggle('notes', 'Bill notes')}</div>
          <h5>Sign-off</h5>
          <div className="ps-grid">{toggle('terms', 'Terms & conditions')}{toggle('signatory', 'Authorised signatory')}{toggle('receiver', "Receiver's signature")}{toggle('computerLine', 'Computer-generated line')}</div>
          <label className="ps-field">Signatory label<input value={draft.signLabel} placeholder="Authorised Signatory" onChange={(e) => set({ signLabel: e.target.value })} /></label>
        </>}
        {tab === 'style' && <>
          <h5>Colour</h5>
          <div className="ps-swatches">{COLOURS.map((c) => <button key={c} type="button" aria-label={c} className={draft.accent === c ? 'is-on' : ''} style={{ background: c }} onClick={() => set({ accent: c })} />)}
            <input type="color" aria-label="Custom colour" value={draft.accent} onChange={(e) => set({ accent: e.target.value })} /></div>
          <h5>Font</h5>
          <div className="ps-seg">{([['default', 'Default'], ['arial', 'Arial'], ['georgia', 'Georgia']] as const).map(([k, l]) => <button key={k} type="button" className={draft.font === k ? 'is-on' : ''} onClick={() => set({ font: k })}>{l}</button>)}</div>
          <h5>Page</h5>
          <div className="ps-grid">{toggle('border', 'Border around page')}</div>
        </>}
      </div>
      <div className="ps-foot">
        <button type="button" className="btn btn-sm" onClick={() => { savePrint(null); setDraft(DEFAULT_PRINT); onChange(DEFAULT_PRINT) }}>Reset all to default</button>
        <button type="button" className="btn btn-primary" onClick={() => { savePrint(draft); onClose() }}>Save</button>
      </div>
    </aside>
  )
}
