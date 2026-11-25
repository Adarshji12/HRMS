/* Sale Bill — raised against a ledger picked from the party list, or a walk-in customer.
 *
 * Keys: F3 party list · ↑ ↓ move · Enter select · Esc back · F4 customers / suppliers · Ctrl+S save.
 * A bill is saved with its lines and totals; it does not yet move stock or post to the ledger.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '../../lib/useQuery'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconSheet } from '../../components/Icons'
import { daysFromTodayISO, todayISO } from '../crm/api'
import AskBox from './AskBox'
import ErpDocList from './ErpDocList'
import { preview } from './ErpBillSeries'
import '../../styles/so-form.css'
import { Dialog as CrmDialog } from '../crm/parts'
import { CrmPage } from '../crm/parts'
import { ErpPage, Field, DateText, useAccess, useRun } from './parts'
import { erp, rupees, type BillSeriesData, type CustomerAccount, type Item, type Ledger, type OpeningLot, type SaleBill, type Walkin, type Warehouse } from './api'

const num = (s: string) => Number(s || 0)

/* ================================================================ the register */

export function ErpQuotation() {
  return <ErpSaleBill kind="quotation" />
}

export function ErpStockIssue() {
  return <ErpSaleBill kind="issue" />
}

export function ErpSaleReturn() {
  return <ErpSaleBill kind="return" />
}

export default function ErpSaleBill({ kind = 'bill' }: { kind?: 'bill' | 'quotation' | 'return' | 'issue' }) {
  const quote = kind === 'quotation'
  const ret = kind === 'return'
  const issue = kind === 'issue'
  const slim = quote || ret || issue
  const word = quote ? 'Quotation' : ret ? 'Sale Return' : issue ? 'Stock Issue' : 'Sale Bill'
  const { can, loaded } = useAccess()
  const [entryKey, setEntryKey] = useState(0)
  const [view, setView] = useState<'new' | 'list' | null>(null)
  const [q, setQ] = useState('')
  const [shown, setShown] = useState<SaleBill | null>(null)
  const list = useQuery<SaleBill[]>(`erp-sale-bills-${kind}-${q}`, () => erp.saleBills({ q: q.trim() || undefined, doc_type: kind }))
  const rows = list.data ?? []
  const shownView = view ?? (!slim && loaded && can('can_manage_billing') ? 'new' : 'list')
  if (!loaded) return <CrmPage><Loading /></CrmPage>
  if (shownView === 'new' && can('can_manage_billing')) {
    return (
      <CrmPage>
        <SaleBillEntry key={entryKey} inline kind={kind} onClose={() => { setView('list'); list.reload() }}
          onSaved={(again) => { list.reload(); if (again) setEntryKey((n) => n + 1); else setView('list') }} />
      </CrmPage>
    )
  }
  if (slim) {
    return (
      <CrmPage>
        <ErpDocList kind={kind as 'quotation' | 'return' | 'issue'} word={word} rows={rows} loading={!list.data} error={list.error}
          canNew={can('can_manage_billing')} onNew={() => setView('new')} onOpen={(b) => erp.saleBill(b.id).then(setShown)} />
        {shown && <BillView bill={shown} word={word} onClose={() => setShown(null)} />}
      </CrmPage>
    )
  }
  return (
    <ErpPage title={word} subtitle={ret ? 'Goods a customer sent back, against a bill or on their own.' : quote ? 'Estimates for a ledger or a walk-in customer. Nothing moves from a quotation.' : 'Bills raised against a ledger or a walk-in customer.'}
             actions={can('can_manage_billing') && <button className="btn btn-primary" onClick={() => setView('new')}>+ New</button>}>
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="crm-bar itl-bar">
          <div className="crm-search"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="No. or party" aria-label={`Search ${word}`} /></div>
          <span className="itl-count crm-push">{quote ? 'Quotations' : ret ? 'Returns' : 'Bills'}: <b>{rows.length}</b></span>
        </div>
        {list.error && <ErrorNote>{list.error}</ErrorNote>}
        {!list.data ? <Loading /> : rows.length === 0 ? (
          <EmptyState icon={<IconSheet size={22} />} title={q ? 'Nothing matches' : quote ? 'No quotations yet' : ret ? 'No sale returns yet' : 'No sale bills yet'} body={q ? 'Change the search.' : 'Add the first one with the Add button.'} />
        ) : (
          <div className="table-wrap"><table className="itl">
            <thead><tr><th>{slim ? 'No.' : 'Bill no.'}</th><th>Date</th><th>Party</th>{slim ? <><th>Station</th><th>Mobile</th><th>{ret ? 'Against bill' : 'Valid till'}</th></> : <><th>Type</th><th>Store</th></>}<th style={{ textAlign: 'right' }}>Taxable</th><th style={{ textAlign: 'right' }}>GST</th><th style={{ textAlign: 'right' }}>Net amount</th>{slim && <th>Status</th>}</tr></thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} style={{ cursor: 'pointer' }} onClick={() => erp.saleBill(b.id).then(setShown)}>
                  <td className="crm-code">{b.number}</td><td><DateText iso={b.bill_date} /></td><td><b>{b.party_name}</b></td>
                  {slim ? <><td>{b.station ?? '—'}</td><td>{b.mobile ?? '—'}</td><td>{ret ? (b.against_number ?? '—') : b.valid_till ? <DateText iso={b.valid_till} /> : '—'}</td></>
                    : <><td>{b.bill_type === 'cash' ? 'Cash' : 'Credit'}</td><td>{b.warehouse_name ?? '—'}</td></>}
                  <td style={{ textAlign: 'right' }}>{rupees(b.sub_total)}</td><td style={{ textAlign: 'right' }}>{rupees(b.tax_total)}</td><td style={{ textAlign: 'right' }}><b>{rupees(b.grand_total)}</b></td>
                  {slim && <td><span className="mh-card-badge">{b.status === 'open' ? 'Open' : b.status}</span></td>}
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
      {shown && <BillView bill={shown} word={word} onClose={() => setShown(null)} />}
    </ErpPage>
  )
}

function BillView({ bill, word, onClose }: { bill: SaleBill; word: string; onClose: () => void }) {
  return (
    <CrmDialog wide title={`${word} ${bill.number}`} subtitle={`${bill.party_name} · ${bill.bill_type === 'cash' ? 'Cash' : 'Credit'}${bill.warehouse_name ? ` · ${bill.warehouse_name}` : ''}`} onClose={onClose}
               footer={<button className="btn btn-primary crm-push" onClick={onClose}>Close</button>}>
      <div style={{ overflowY: 'auto', minHeight: 0, flex: 1 }}>
        <div className="table-wrap"><table className="itl">
          <thead><tr><th>Sr</th><th>Item</th><th>S.Stock</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Free</th><th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>GST %</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
          <tbody>{(bill.lines ?? []).map((l) => (
            <tr key={l.id}><td>{l.line_no}</td><td>{l.description}</td><td>{l.lot_no ?? '—'}</td><td style={{ textAlign: 'right' }}>{num(l.quantity)} {l.uom ?? ''}</td><td style={{ textAlign: 'right' }}>{num(l.free_qty) || '—'}</td>
              <td style={{ textAlign: 'right' }}>{rupees(l.rate)}</td><td style={{ textAlign: 'right' }}>{num(l.gst_percent)}</td><td style={{ textAlign: 'right' }}>{rupees(l.amount)}</td></tr>
          ))}</tbody>
        </table></div>
        <p style={{ textAlign: 'right', margin: '12px 4px' }}>Taxable {rupees(bill.sub_total)} · GST {rupees(bill.tax_total)} · <b>Net {rupees(bill.grand_total)}</b></p>
      </div>
    </CrmDialog>
  )
}

/* ================================================================ the entry screen */

type Party = { kind: 'ledger'; ledger: Ledger } | { kind: 'walkin'; walkin: Walkin | null }
interface Row { item: Item | null; text: string; lot: string; qty: string; free: string; uom: string; mrp: string; rate: string; dis: string; gst: string }
const blankRow = (): Row => ({ item: null, text: '', lot: '', qty: '', free: '', uom: '', mrp: '', rate: '', dis: '', gst: '' })
const MIN_ROWS = 8

function rowAmount(r: Row, mode: '%' | '₹') {
  const gross = num(r.qty) * num(r.rate)
  const after = Math.max(mode === '%' ? gross - (gross * num(r.dis)) / 100 : gross - num(r.dis), 0)
  return { gross, taxable: after, tax: (after * num(r.gst)) / 100, amount: after + (after * num(r.gst)) / 100 }
}

const cell: React.CSSProperties = { border: 0, background: 'transparent', width: '100%', padding: '6px 8px', font: 'inherit', outline: 'none' }
const right: React.CSSProperties = { ...cell, textAlign: 'right' }

export function SaleBillEntry({ onClose, onSaved, kind = 'bill', inline = false }: { onClose: () => void; onSaved: (again: boolean) => void; kind?: 'bill' | 'quotation' | 'return' | 'issue'; inline?: boolean }) {
  const quote = kind === 'quotation'
  const ret = kind === 'return'
  const issue = kind === 'issue'
  const slim = quote || ret || issue
  const word = quote ? 'Quotation' : ret ? 'Sale Return' : issue ? 'Stock Issue' : 'Sale Bill'
  const [against, setAgainst] = useState('')
  const [cur, setCur] = useState(0)
  const seriesQ = useQuery<BillSeriesData>(`erp-bill-series-${kind}`, () => erp.billSeries(), { enabled: slim })
  const seriesKey = quote ? 'quotation' : ret ? 'credit_note' : issue ? 'stock_issue' : ''
  const mainSeries = (seriesQ.data?.series ?? []).filter((x) => x.transaction === seriesKey).sort((a, b) => Number(b.is_default) - Number(a.is_default))[0]
  const nextNo = mainSeries ? preview(mainSeries) : null
  const [billPick, setBillPick] = useState(false)
  type PickBill = { id: string; number: string | null; customer_name: string; kind: string; invoice_date: string; grand_total: string; src: 'invoice' | 'bill' }
  const billsList = useQuery<PickBill[]>('erp-return-bills', async () => {
    const [inv, sb] = await Promise.all([erp.invoices({}), erp.saleBills({ doc_type: 'bill' })])
    return [
      ...inv.map((i) => ({ id: i.id, number: i.number, customer_name: i.customer_name, kind: i.kind, invoice_date: i.invoice_date, grand_total: i.grand_total, src: 'invoice' as const })),
      ...sb.map((x) => ({ id: x.id, number: x.number, customer_name: x.party_name, kind: 'bill', invoice_date: x.bill_date, grand_total: x.grand_total, src: 'bill' as const })),
    ].sort((p, q) => q.invoice_date.localeCompare(p.invoice_date))
  }, { enabled: ret })
  const [validTill, setValidTill] = useState(() => daysFromTodayISO(15))
  const [confirming, setConfirming] = useState(false)
  const [askNext, setAskNext] = useState<SaleBill | null>(null)
  const stores = useQuery<Warehouse[]>('erp-sb-stores', () => erp.warehouses(true))
  const itemsQ = useQuery<Item[]>('erp-sb-items', () => erp.items({ active_only: true }))
  const [party, setParty] = useState<Party | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [walkinOpen, setWalkinOpen] = useState(false)
  const [date, setDate] = useState(todayISO())
  const [type, setType] = useState<'credit' | 'cash'>('credit')
  const [store, setStore] = useState('')
  const [mode, setMode] = useState<'%' | '₹'>('%')
  const [rows, setRows] = useState<Row[]>(() => Array.from({ length: ret ? 5 : MIN_ROWS }, blankRow))
  const [focus, setFocus] = useState<number | null>(null)       // the row whose item box is open
  const [hot, setHot] = useState(0)
  const [lots, setLots] = useState<Record<string, OpeningLot[]>>({})
  const [notes, setNotes] = useState('')
  const { busy, error, run } = useRun()
  const storeList = stores.data ?? []
  const storeId = store || storeList.find((w) => w.is_default)?.id || storeList[0]?.id || ''
  const goods = useMemo(() => (itemsQ.data ?? []).filter((i) => i.is_active && i.can_be_sold !== false), [itemsQ.data])
  const partyName = !party ? '' : party.kind === 'ledger' ? party.ledger.name : party.walkin?.name ?? 'Walk-in Customer'

  const update = (i: number, patch: Partial<Row>) => setRows((c) => {
    const next = c.map((r, j) => (j === i ? { ...r, ...patch } : r))
    return next.slice(0, next.length).concat(next.every((r) => r.text || r.item) ? [blankRow()] : [])
  })

  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (pickerOpen || walkinOpen || confirming || askNext) return
      if (e.key === 'F3') { e.preventDefault(); setPickerOpen(true) }
      else if ((e.key === 's' && (e.ctrlKey || e.metaKey)) || e.key === 'F10') { e.preventDefault(); ask() }
      else if (e.key === 'Escape' && focus === null) onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  async function loadLots(item: Item) {
    if (!storeId || lots[item.id]) return
    try { const l = await erp.openingLots(item.id, storeId); setLots((c) => ({ ...c, [item.id]: l.filter((x) => num(x.quantity) > 0) })) } catch { setLots((c) => ({ ...c, [item.id]: [] })) }
  }

  const [note, setNote] = useState<string | null>(null)
  useEffect(() => { if (!note) return; const id = setTimeout(() => setNote(null), 5000); return () => clearTimeout(id) }, [note])

  /** Choosing a bill brings its items in, ready to change to what came back. */
  async function bringIn(b: { id: string; number: string | null; customer_name: string; src: 'invoice' | 'bill' }) {
    setAgainst(b.number ?? '')
    try {
      let got: Array<{ item_id: string | null; description: string; quantity: string; uom?: string | null; rate?: string; discount_percent?: string; gst_percent?: string }>
      if (b.src === 'invoice') {
        const inv = await erp.invoice(b.id)
        got = (inv.lines ?? []).filter((l) => !(l as { is_charge?: boolean }).is_charge)
      } else {
        got = (await erp.saleBill(b.id)).lines ?? []
      }
      const made: Row[] = got.map((l) => {
        const item = (itemsQ.data ?? []).find((x) => x.id === l.item_id) ?? null
        return { item, text: l.description, lot: '', qty: String(num(l.quantity)), free: '', uom: l.uom ?? item?.uom ?? '', mrp: '', rate: String(num(l.rate ?? '0') || ''), dis: num(l.discount_percent ?? '0') ? String(num(l.discount_percent ?? '0')) : '', gst: String(num(l.gst_percent ?? '0')) }
      })
      if (made.length) {
        setMode('%')
        setRows([...made, ...Array.from({ length: Math.max(1, (ret ? 5 : MIN_ROWS) - made.length) }, blankRow)])
        setNote(`${made.length} item${made.length === 1 ? '' : 's'} brought in from ${b.number ?? 'the bill'}`)
      }
      if (!party) {
        const ls = await erp.ledgers()
        const match = ls.find((l) => l.name === b.customer_name)
        if (match) setParty({ kind: 'ledger', ledger: match })
      }
    } catch { setNote('The bill’s items could not be loaded') }
  }

  function pickItem(i: number, item: Item) {
    update(i, { item, text: item.name, uom: item.uom, rate: String((issue ? num(item.standard_cost) || num(item.sale_price) : num(item.sale_price)) || ''), mrp: '', gst: issue ? '0' : String(num(item.gst_percent)), qty: rows[i].qty || '1', lot: '' })
    setFocus(null)
    void loadLots(item)
  }

  function pickLot(i: number, lotNo: string) {
    const lot = (lots[rows[i].item?.id ?? ''] ?? []).find((l) => l.lot_no === lotNo)
    update(i, lot ? { lot: lotNo, mrp: num(lot.mrp) ? String(num(lot.mrp)) : '', rate: num(lot.rate_a) ? String(num(lot.rate_a)) : rows[i].rate } : { lot: '' })
  }

  const used = rows.filter((r) => r.item || r.text.trim())
  const totals = used.reduce((t, r) => { const a = rowAmount(r, mode); return { gross: t.gross + a.gross, taxable: t.taxable + a.taxable, tax: t.tax + a.tax, amount: t.amount + a.amount, qty: t.qty + num(r.qty) } }, { gross: 0, taxable: 0, tax: 0, amount: 0, qty: 0 })
  const bad = used.some((r) => !(num(r.qty) > 0))
  const blocked = issue ? (!storeId ? 'Choose the store it is issued to' : null) ?? (used.length === 0 ? 'Add at least one item' : bad ? 'Enter the quantity on every line' : null) : !party ? 'Choose the party (F3)' : used.length === 0 ? 'Add at least one item' : bad ? 'Enter the quantity on every line' : null

  function ask() { if (!blocked) setConfirming(true) }

  function save() {
    if (blocked) return
    setConfirming(false)
    void run(async () => {
      const made = await erp.createSaleBill({
        doc_type: kind, valid_till: quote ? validTill || undefined : undefined,
        bill_date: date, bill_type: type, against_number: ret ? against || undefined : undefined,
        warehouse_id: slim && !issue ? undefined : storeId || undefined, notes: notes || undefined,
        ...(issue ? { issued_to: storeList.find((w) => w.id === storeId)?.name ?? '' } : party!.kind === 'ledger' ? { ledger_id: party!.ledger.id } : party!.walkin ? { walkin_id: party!.walkin.id } : { walkin_bill: true }),
        lines: used.map((r) => ({
          item_id: r.item?.id, description: r.item?.name ?? r.text.trim(), lot_no: r.lot || undefined, quantity: r.qty, free_qty: r.free || '0', uom: r.uom || undefined,
          mrp: r.mrp || '0', rate: r.rate || '0', gst_percent: r.gst || '0',
          ...(mode === '%' ? { discount_percent: r.dis || '0' } : { discount_amount: r.dis || '0' }),
        })),
      })
      setAskNext(made)
    }, quote ? 'The quotation could not be saved' : ret ? 'The sale return could not be saved' : 'The bill could not be saved')
  }

  return (
    <div style={inline ? undefined : { position: 'fixed', inset: 0, zIndex: 70, background: 'var(--bg, #f5f6fa)', display: 'flex', flexDirection: 'column', padding: '16px 28px' }}>
    <div className="sb sb-page" style={{ flex: 1, minHeight: inline ? 'calc(100vh - 150px)' : 0, display: 'flex', flexDirection: 'column' }}>
      <div className="sb-bar">
        <span className="sb-bar-icon" aria-hidden><IconSheet size={17} /></span>
        <div className="sb-bar-text">
          <h2 className="sb-title">{word}</h2>
          <span className="sb-bar-status"><i className="is-new" />New · not saved yet</span>
        </div>
        <span className="sb-bar-gap" />
        <button type="button" className="btn btn-sm" onClick={onClose}>{inline ? `All ${quote ? 'quotations' : ret ? 'returns' : 'bills'}` : 'Close'} <kbd>Esc</kbd></button>
      </div>
      <div className="sb-head">
        {issue ? (
          <label className="sb-f" style={{ gridColumn: 'span 6' }}><span>Issued to</span>
            <select value={storeId} onChange={(e) => setStore(e.target.value)} aria-label="Issued to">{storeList.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        ) : (
        <label className="sb-f" style={{ gridColumn: 'span 6', cursor: 'pointer', background: party ? undefined : '#fff8dc' }} onClick={() => setPickerOpen(true)}>
          <span>Name <kbd>F3</kbd></span>
          <input readOnly value={partyName} placeholder="Select party…" style={{ cursor: 'pointer' }} onFocus={() => !party && setPickerOpen(true)} aria-label="Party" />
        </label>
        )}
        <label className="sb-f" style={{ gridColumn: 'span 2', opacity: 0.85 }}><span>{slim ? 'No.' : 'Bill no.'}</span><input readOnly value={nextNo ?? 'Auto'} title="Next number on the bill series" aria-label="Number" /></label>
        <label className="sb-f" style={{ gridColumn: 'span 2' }}><span>Date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" /></label>
        {issue ? (
          <>
            <label className="sb-f" style={{ gridColumn: 'span 6' }}><span>Narration</span><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" aria-label="Narration" /></label>
            <label className="sb-f" style={{ gridColumn: 'span 4' }}><span>Value</span><input readOnly value={rupees(totals.amount)} style={{ textAlign: 'right' }} aria-label="Value" /></label>
          </>
        ) : ret ? (
          <>
            <label className="sb-f" style={{ gridColumn: 'span 5', cursor: 'pointer' }} onClick={() => setBillPick(true)}>
              <span style={{ whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', marginRight: 14 }}>Against bill</span>
              <input readOnly value={against} placeholder="Pick the bill" style={{ cursor: 'pointer' }} aria-label="Against bill"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setBillPick(true) } }} />
              {against && <button type="button" className="crm-icon-btn" aria-label="Clear the bill" onClick={(e) => { e.stopPropagation(); setAgainst('') }}>×</button>}</label>
            <label className="sb-f" style={{ gridColumn: 'span 5' }}><span>Narration</span><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" aria-label="Narration" /></label>
          </>
        ) : quote ? (
          <>
            <label className="sb-f" style={{ gridColumn: 'span 3' }}><span>Valid till</span><input type="date" value={validTill} min={date} onChange={(e) => setValidTill(e.target.value)} aria-label="Valid till" /></label>
            <label className="sb-f" style={{ gridColumn: 'span 7' }}><span>Narration</span><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" aria-label="Narration" /></label>
          </>
        ) : (
          <>
            <label className="sb-f" style={{ gridColumn: 'span 3' }}><span>Type</span>
              <select value={type} onChange={(e) => setType(e.target.value as 'credit' | 'cash')} aria-label="Bill type"><option value="credit">Credit</option><option value="cash">Cash</option></select></label>
            <label className="sb-f" style={{ gridColumn: 'span 3' }}><span>Store</span>
              <select value={storeId} onChange={(e) => { setStore(e.target.value); setLots({}) }} aria-label="Store">{storeList.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
          </>
        )}
      </div>
      {party?.kind === 'walkin' && (
        <div className="muted-sm" style={{ padding: '6px 14px' }}>
          {party.walkin ? `${party.walkin.name}${party.walkin.mobile ? ` · ${party.walkin.mobile}` : ''}` : 'No customer details taken.'}{' '}
          <button type="button" className="link-btn" onClick={() => setWalkinOpen(true)}>{party.walkin ? 'Change' : 'Add details'}</button>
        </div>
      )}
      <section style={{ display: 'contents' }}>
      <div className="sb-grid" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <table style={{ width: '100%', tableLayout: 'fixed' }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 2 }}><tr>
            <th className="sb-c-sr" style={{ width: 44 }}>Sr</th><th>Item name <kbd>F2</kbd></th>{ret && <th style={{ width: 100 }}>HSN/SAC</th>}{!slim && <th style={{ width: 130 }}>S.Stock</th>}<th style={{ width: 80, textAlign: 'right' }}>Qty</th>{!issue && <th style={{ width: 70, textAlign: 'right' }}>Free</th>}
            <th style={{ width: 70 }}>Unit</th>{!slim && <th style={{ width: 90, textAlign: 'right' }}>M.R.P.</th>}<th style={{ width: 100, textAlign: 'right' }}>{issue ? 'Cost' : 'Rate'}</th>
            {!issue && <th style={{ width: 120 }}>Dis
              <span className="sb-mini-seg">{(['%', '₹'] as const).map((m) => <button key={m} type="button" className={mode === m ? 'is-on' : ''} onClick={() => setMode(m)}>{m}</button>)}</span></th>}
            {!issue && <th style={{ width: 80, textAlign: 'right' }}>GST %</th>}<th style={{ width: 120, textAlign: 'right' }}>{issue ? 'Value' : 'Amount'}</th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const amt = rowAmount(r, mode).amount
              const rowLots = r.item ? lots[r.item.id] ?? [] : []
              const needle = r.text.trim().toLowerCase()
              const hits = focus === i && !r.item ? goods.filter((g) => !needle || [g.code, g.name, g.barcode].some((x) => x && x.toLowerCase().includes(needle))).slice(0, 8) : []
              return (
                <tr key={i}>
                  <td className="sb-c-sr">{i + 1}</td>
                  <td style={{ position: 'relative' }}>
                    <input value={r.text} style={cell} aria-label={`Item, line ${i + 1}`} placeholder={i === 0 ? 'Type the item name or code' : ''}
                           onFocus={() => { setFocus(i); setHot(0); setCur(i) }} onBlur={() => setTimeout(() => setFocus((f) => (f === i ? null : f)), 150)}
                           onChange={(e) => update(i, { text: e.target.value, item: null })}
                           onKeyDown={(e) => {
                             if (e.key === 'ArrowDown') { e.preventDefault(); setHot((h) => Math.min(h + 1, hits.length - 1)) }
                             else if (e.key === 'ArrowUp') { e.preventDefault(); setHot((h) => Math.max(h - 1, 0)) }
                             else if (e.key === 'Enter' && hits[hot]) { e.preventDefault(); pickItem(i, hits[hot]) }
                             else if (e.key === 'Escape') { e.stopPropagation(); setFocus(null) }
                           }} />
                    {hits.length > 0 && (
                      <div style={{ position: 'absolute', left: 0, top: '100%', zIndex: 5, minWidth: 340, background: 'var(--surface, #fff)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.15)' }}>
                        {hits.map((g, n) => (
                          <div key={g.id} onMouseDown={(e) => { e.preventDefault(); pickItem(i, g) }} onMouseEnter={() => setHot(n)}
                               style={{ padding: '6px 10px', cursor: 'pointer', background: n === hot ? 'var(--brand-soft)' : undefined, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                            <span><b>{g.name}</b> <span className="muted-sm">{g.code}</span></span><span className="muted-sm">{num(g.sale_price) ? rupees(g.sale_price) : ''}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                  {ret && <td><input readOnly tabIndex={-1} value={(r.item as { hsn_sac?: string | null } | null)?.hsn_sac ?? ''} style={cell} aria-label={`HSN/SAC, line ${i + 1}`} /></td>}
                  {!slim && (<td>{rowLots.length > 0
                    ? <select value={r.lot} style={cell} aria-label={`S.Stock, line ${i + 1}`} onChange={(e) => pickLot(i, e.target.value)}><option value="">—</option>{rowLots.map((l) => <option key={l.id} value={l.lot_no}>{l.lot_no} ({num(l.quantity)})</option>)}</select>
                    : <input value={r.lot} style={cell} disabled={!r.item} aria-label={`S.Stock, line ${i + 1}`} onChange={(e) => update(i, { lot: e.target.value })} />}</td>)}
                  <td><input value={r.qty} inputMode="decimal" style={right} aria-label={`Quantity, line ${i + 1}`} onChange={(e) => update(i, { qty: e.target.value.replace(/[^\d.]/g, '') })} /></td>
                  {!issue && <td><input value={r.free} inputMode="decimal" style={right} aria-label={`Free, line ${i + 1}`} onChange={(e) => update(i, { free: e.target.value.replace(/[^\d.]/g, '') })} /></td>}
                  <td><input value={r.uom} style={cell} aria-label={`Unit, line ${i + 1}`} onChange={(e) => update(i, { uom: e.target.value })} /></td>
                  {!slim && <td><input value={r.mrp} inputMode="decimal" style={right} aria-label={`MRP, line ${i + 1}`} onChange={(e) => update(i, { mrp: e.target.value.replace(/[^\d.]/g, '') })} /></td>}
                  <td><input value={r.rate} inputMode="decimal" style={right} aria-label={`Rate, line ${i + 1}`} onChange={(e) => update(i, { rate: e.target.value.replace(/[^\d.]/g, '') })} /></td>
                  {!issue && <td><input value={r.dis} inputMode="decimal" style={right} aria-label={`Discount, line ${i + 1}`} onChange={(e) => update(i, { dis: e.target.value.replace(/[^\d.]/g, '') })} /></td>}
                  {!issue && <td><input value={r.gst} inputMode="decimal" style={right} aria-label={`GST %, line ${i + 1}`} onChange={(e) => update(i, { gst: e.target.value.replace(/[^\d.]/g, '') })} /></td>}
                  <td className="sb-c-amt">{amt ? rupees(amt) : ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      </section>
      {ret && (
        <div className="sof-panels" style={{ gridTemplateAreas: "'a sum'", gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 360px)', padding: '16px 16px 12px' }}>
          <section className="pof-sec sdt sof-p-a">
            <header className="pof-sec-head"><h3>Return details</h3></header>
            <p className="muted-sm" style={{ margin: 0 }}>{against ? `Against bill ${against}.` : 'Not linked to a bill — pick one with Against bill when you can.'} Stock and the party's balance are not changed by a sale return yet.</p>
          </section>
          <section className="pof-sec sof-p-sum">
            <header className="pof-sec-head"><h3>Charges &amp; tax summary</h3></header>
            <div style={{ display: 'grid', gap: 4, fontSize: 12.5 }}>
              {([['Subtotal', totals.gross], ['Total discount', totals.gross - totals.taxable], ['Taxable amount', totals.taxable], ['GST', totals.tax]] as const).map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between' }}><span>{k}</span><span>{rupees(v)}</span></div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, padding: '10px 14px', borderRadius: 10, background: 'var(--brand)', color: '#fff', fontSize: 16, fontWeight: 700 }}>
                <span style={{ fontSize: 12, letterSpacing: '.06em', textTransform: 'uppercase' }}>Net amount</span><span>{rupees(totals.amount)}</span></div>
            </div>
          </section>
        </div>
      )}
      {!issue && (
      <div className={ret ? 'pof-page-foot' : undefined} style={ret ? undefined : { display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', padding: '10px 14px', borderTop: '1px solid var(--border)', background: 'var(--surface, #fff)' }}>
          {!slim && <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Narration (optional)" aria-label="Narration" style={{ maxWidth: 280 }} />}
          {ret || issue ? <span className="pof-page-total">{issue ? 'Issue' : 'Return'} total <b>{rupees(totals.amount)}</b></span> : <>
            <span className="muted-sm">Items <b>{used.length}</b> · Qty <b>{totals.qty}</b></span>
            <span className="muted-sm">Taxable <b>{rupees(totals.taxable)}</b></span>
            <span className="muted-sm">GST <b>{rupees(totals.tax)}</b></span>
            <span style={{ fontSize: 16 }}>Net <b>{rupees(totals.amount)}</b></span></>}
          <span className="crm-push" />
          {error ? <span className="error">{error}</span> : blocked ? <span className={ret ? 'sof-hint' : 'lf-foot-note lf-foot-link'}>{blocked}</span> : ret && <span className="sof-ok">Ready to save</span>}
          {ret
            ? <button className="btn" onClick={() => { setRows(Array.from({ length: MIN_ROWS }, blankRow)); setParty(null); setAgainst(''); setNotes('') }}>Clear</button>
            : <button className="btn" onClick={onClose}>Cancel</button>}
          <button className="btn btn-primary" disabled={busy || !!blocked} onClick={ask}>{busy ? 'Saving…' : `Save ${word} (Ctrl+S)`}</button>
        </div>
      )}
      {issue && (
        <>
          <div className="sb-foot">
            <section className="sb-panel">
              <h4>Item details</h4>
              {(() => {
                const it = rows[cur]?.item ?? null
                const x = it as unknown as { code?: string; hsn_sac?: string | null; gst_percent?: string; available_qty?: string; is_stocked?: boolean; uom?: string; sale_price?: string; standard_cost?: string } | null
                return it && x ? (
                  <dl>
                    <dt>Item</dt><dd title={it.name}>{it.name}{x.code && <small> ({x.code})</small>}</dd>
                    <dt>HSN / GST</dt><dd>{x.hsn_sac || '—'} · {Number(x.gst_percent || 0)}%</dd>
                    <dt>Stock</dt><dd>{x.is_stocked ? `${Number(x.available_qty || 0)} ${x.uom ?? ''}` : 'Not stocked'}</dd>
                    <dt>Rates</dt><dd>Sale {rupees(Number(x.sale_price || 0))} · Purchase {rupees(Number(x.standard_cost || 0))}</dd>
                  </dl>
                ) : <p className="muted-sm" style={{ margin: 0 }}>Move to an item row to see its stock and rates.</p>
              })()}
            </section>
            <section className="sb-panel">
              <h4>Stock issue</h4>
              <dl>
                <dt>Effect</dt><dd style={{ whiteSpace: 'normal' }}>Stock goes out (qty −) at running cost: Stock Variance Dr, Stock in Hand Cr.</dd>
                <dt>Issued To</dt><dd>{storeList.find((w) => w.id === storeId)?.name ?? '—'}</dd>
              </dl>
            </section>
            <section className="sb-panel">
              <dl><dt>Items / Qty</dt><dd>{used.length} / {totals.qty}</dd></dl>
              <div className="sb-net" style={{ margin: '8px 0' }}><span>Total Value</span><b>{rupees(totals.amount)}</b></div>
              {error && <p className="error sb-error">{error}</p>}
              <div className="sb-save">
                <button type="button" className="btn sb-save-btn" disabled={busy || !!blocked} onClick={ask}>{busy ? 'Saving…' : 'Save Stock Issue'} <kbd>Ctrl+S</kbd></button>
              </div>
            </section>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '8px 16px', background: 'var(--brand, #0b3d6e)', color: '#fff', fontSize: 12.5, borderRadius: '0 0 12px 12px' }}>
            <span><kbd>Esc</kbd> Back</span>
            <span><kbd>F10</kbd> Save</span>
            <span style={{ marginLeft: 'auto', opacity: 0.85 }}>No GST — stock at cost</span>
          </div>
        </>
      )}
      {note && (
        <div role="status" style={{ position: 'fixed', top: 70, right: 24, zIndex: 90, maxWidth: 360, padding: '12px 16px', borderRadius: 12, background: '#fff', border: '1px solid var(--border)', borderLeft: '4px solid var(--brand)', boxShadow: '0 16px 40px rgba(15,23,42,.22)' }}>
          <b>{note}</b>
          {!note.includes('could not') && <div className="muted-sm">Change the quantities to what came back; delete rows you do not need.</div>}
        </div>
      )}
      {billPick && <BillPicker title={party ? `${partyName} — sale bills` : 'Sale bills'} bills={(billsList.data ?? []).filter((b) => b.kind !== 'credit_note' && b.number && (!party || b.customer_name === partyName))}
        onClose={() => setBillPick(false)} onPick={(b) => { setBillPick(false); void bringIn(b) }} />}
      {confirming && <AskBox title={`Save this ${quote ? 'quotation' : ret ? 'sale return' : 'bill'}?`} sub={`Total ${rupees(totals.amount)}`} yes="Yes" onYes={save} onNo={() => setConfirming(false)} />}
      {askNext && <AskBox title={`${word} ${askNext.number} saved`} sub={`${rupees(askNext.grand_total)} · Enter the next one? (N opens this one)`} yes="Yes" onYes={() => onSaved(true)} onNo={() => onSaved(false)} />}
      {pickerOpen && <PartyPicker onClose={() => setPickerOpen(false)} onPick={(p) => { setPickerOpen(false); if (p.kind === 'customer' || p.kind === 'row') return; setParty(p); if (p.kind === 'walkin') setWalkinOpen(true) }} />}
      {walkinOpen && <WalkinDetails current={party?.kind === 'walkin' ? party.walkin : null} onClose={() => setWalkinOpen(false)} onDone={(w) => { setWalkinOpen(false); setParty({ kind: 'walkin', walkin: w }) }} />}
    </div>
    </div>
  )
}

/* ================================================================ party list */

type Tab = 'all' | 'customers' | 'suppliers'
const WALKIN_ROW = Symbol('walkin')

/** One line of the party list, whether it comes from a ledger or from a customer record. */
interface PickRow {
  id: string; name: string; city: string; gstin: string; balance: string; address: string[]; phone: string; tags: string[]
  source: { kind: 'ledger'; ledger: Ledger } | { kind: 'customer'; customer: CustomerAccount } | { kind: 'row'; id: string }
}
export type { PickRow }
export type PickResult = Party | { kind: 'customer'; customer: CustomerAccount } | { kind: 'row'; id: string }

const fromLedger = (l: Ledger): PickRow => ({
  id: l.id, name: l.name, city: l.city ?? '', gstin: l.gstin ?? '',
  balance: `${rupees(l.balance)}${num(l.balance) ? ` ${l.balance_type === 'dr' ? 'Dr' : 'Cr'}` : ''}`,
  address: [[l.address1, l.address2, l.address3].filter(Boolean).join(', '), [l.city, l.pincode].filter(Boolean).join(' – ')],
  phone: l.mobile ?? '', tags: [l.account_group, l.gstin ? 'Registered' : 'Unregistered', l.state].filter(Boolean) as string[],
  source: { kind: 'ledger', ledger: l },
})
const fromCustomer = (c: CustomerAccount): PickRow => ({
  id: c.customer_id, name: c.contact_name || c.customer_name, city: '', gstin: c.account?.gstin ?? c.crm_gstin ?? '',
  balance: rupees(c.outstanding),
  address: [c.account?.billing_address ?? '', c.account?.billing_state ?? ''],
  phone: c.mobile, tags: [c.customer_code, c.account?.gstin || c.crm_gstin ? 'Registered' : 'Unregistered'],
  source: { kind: 'customer', customer: c },
})

/** The Select Party list. With `customers` it lists those (the invoice form bills customer
 *  records); without, it lists ledgers. Either way a walk-in row sits on top. */
export function PartyPicker({ onClose, onPick, customers, rows: given, noWalkin }: { onClose: () => void; onPick: (p: PickResult) => void; customers?: CustomerAccount[]; rows?: PickRow[]; noWalkin?: boolean }) {
  const fixed = Boolean(customers || given)
  const ledgers = useQuery<Ledger[]>('erp-sb-ledgers', () => erp.ledgers(), { enabled: !fixed })
  const [tab, setTab] = useState<Tab>('customers')
  const [q, setQ] = useState('')
  const [hot, setHot] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])
  const needle = q.trim().toLowerCase()
  const loaded = customers ?? given ?? ledgers.data
  const list: Array<PickRow | typeof WALKIN_ROW> = useMemo(() => {
    const match = (r: PickRow) => !needle || [r.name, r.city, r.phone, r.gstin].some((x) => x && x.toLowerCase().includes(needle))
    const rows = given
      ? given.filter(match)
      : customers
      ? customers.filter((c) => c.customer_code !== 'WALK-IN').map(fromCustomer).filter(match)
      : (ledgers.data ?? []).filter((l) => l.is_active && (tab === 'all' || (tab === 'customers' ? /debtor/i.test(l.account_group) : /creditor/i.test(l.account_group)))).map(fromLedger).filter(match)
    const walkin = !noWalkin && (fixed || tab !== 'suppliers') && (!needle || 'walk-in customer'.includes(needle))
    return walkin ? [WALKIN_ROW, ...rows] : rows
  }, [customers, given, ledgers.data, tab, needle])
  const at = Math.min(hot, Math.max(list.length - 1, 0))
  const current = list[at]
  const pick = (row: PickRow | typeof WALKIN_ROW | undefined) => { if (row) onPick(row === WALKIN_ROW ? { kind: 'walkin', walkin: null } : row.source) }
  const next = (t: Tab): Tab => (t === 'customers' ? 'suppliers' : 'customers')

  function key(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHot(Math.min(at + 1, list.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHot(Math.max(at - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); pick(current) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    else if (e.key === 'F4' && !fixed) { e.preventDefault(); setTab(next(tab)); setHot(0) }
  }
  const led = current && current !== WALKIN_ROW ? current : null
  const tabBtn = (t: Tab, label: string) => <button type="button" className={`btn btn-sm${tab === t ? ' btn-primary' : ''}`} onClick={() => { setTab(t); setHot(0); inputRef.current?.focus() }}>{label}</button>
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(15,23,42,.45)', display: 'grid', placeItems: 'center' }} onKeyDown={key} onClick={onClose}>
      <div className="card" style={{ width: 'min(900px, 94vw)', height: 'min(560px, 90vh)', padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
          <b>Select Party</b>{!fixed && <>{tabBtn('all', 'All Ledgers')}{tabBtn('customers', 'Customers')}{tabBtn('suppliers', 'Suppliers')}</>}
          <span className="crm-push muted-sm">{list.length} found</span>
        </div>
        <div style={{ padding: '8px 16px' }}><input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setHot(0) }} placeholder="Search by name, city or mobile" aria-label="Search the party list" style={{ width: '100%' }} /></div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {!loaded ? <Loading /> : (
            <table className="itl"><thead style={{ position: 'sticky', top: 0 }}><tr><th>Party name</th><th>City</th><th>GSTIN</th><th style={{ textAlign: 'right' }}>Outstanding</th></tr></thead>
              <tbody>
                {list.map((row, n) => {
                  const r = row === WALKIN_ROW ? null : row
                  return (
                    <tr key={r?.id ?? 'walkin'} ref={(el) => { if (el && n === at) el.scrollIntoView({ block: 'nearest' }) }} onClick={() => pick(row)} onMouseEnter={() => setHot(n)}
                        style={{ cursor: 'pointer', background: n === at ? 'var(--brand-soft)' : undefined }}>
                      <td><b>{r ? r.name : 'Walk-in Customer'}</b></td><td>{r?.city ?? ''}</td><td className="itl-mono">{r?.gstin ?? ''}</td>
                      <td style={{ textAlign: 'right' }}>{r ? r.balance : rupees(0)}</td>
                    </tr>
                  )
                })}
                {list.length === 0 && <tr><td colSpan={4} className="muted-sm" style={{ padding: 18 }}>No party matches.</td></tr>}
              </tbody></table>
          )}
        </div>
        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', background: 'var(--surface-2, #fffbea)', minHeight: 84, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
          {led ? (<>
            <div><div className="muted-sm">Address</div><b>{led.name}</b>{led.address.map((a, i) => a ? <div key={i}>{a}</div> : null)}<div className="muted-sm">Phone: {led.phone || '—'}</div></div>
            <div><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{led.tags.map((t) => <span key={t} className="mh-card-badge">{t}</span>)}</div>
              <div className="muted-sm" style={{ marginTop: 6 }}>Outstanding: <b>{led.balance}</b></div></div>
          </>) : <div className="muted-sm">{current === WALKIN_ROW ? 'A cash sale to a customer who has no account. You can take their details on the next screen.' : ''}</div>}
        </div>
        <div className="muted-sm" style={{ display: 'flex', gap: 18, padding: '8px 16px', borderTop: '1px solid var(--border)' }}>
          <span><kbd>↑</kbd> <kbd>↓</kbd> Move</span><span><kbd>Enter</kbd> Select</span><span><kbd>Esc</kbd> Back</span>{!fixed && <span><kbd>F4</kbd> Customers → Suppliers</span>}
        </div>
      </div>
    </div>
  )
}

/* ================================================================ walk-in details */

export function WalkinDetails({ current, onClose, onDone }: { current: Walkin | null; onClose: () => void; onDone: (w: Walkin | null) => void }) {
  const [f, setF] = useState({ mobile: current?.mobile ?? '', name: current?.name ?? '', whatsapp: current?.whatsapp ?? '', email: current?.email ?? '', dob: current?.dob ?? '', anniversary: current?.anniversary ?? '', remark: current?.remark ?? '' })
  const [existing, setExisting] = useState<Walkin | null>(current)
  const { busy, error, run } = useRun()
  const mobileRef = useRef<HTMLInputElement>(null)
  useEffect(() => mobileRef.current?.focus(), [])
  const set = (patch: Partial<typeof f>) => setF((c) => ({ ...c, ...patch }))

  // An existing customer comes up as the mobile number is typed.
  useEffect(() => {
    const digits = f.mobile.replace(/\D/g, '').slice(-10)
    if (digits.length < 10 || existing?.mobile === digits) return
    let live = true
    void erp.walkins({ q: digits }).then((r) => {
      const hit = r.find((w) => w.mobile === digits)
      if (live && hit) { setExisting(hit); setF((c) => ({ ...c, name: hit.name, whatsapp: hit.whatsapp ?? '', email: hit.email ?? '', dob: hit.dob ?? '', anniversary: hit.anniversary ?? '', remark: hit.remark ?? '' })) }
    }).catch(() => undefined)
    return () => { live = false }
  }, [f.mobile])  // eslint-disable-line react-hooks/exhaustive-deps

  const body = () => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() || null]).concat([['name', f.name.trim()]]))
  function save() {
    void run(async () => { onDone(existing ? await erp.saveWalkin(body(), existing.id) : await erp.saveWalkin(body())) }, 'The customer could not be saved')
  }
  const missing = !f.name.trim()
  const row = (label: string, el: React.ReactNode) => <div style={label === 'Remark' ? { gridColumn: '1 / -1' } : undefined}><Field label={label}>{el}</Field></div>
  return (
    <CrmDialog medium title="Walk-in Customer Details" subtitle="Type the mobile number. An existing customer comes up as you type." onClose={onClose}
               footer={<>
                 {error && <span className="error">{error}</span>}
                 {!error && missing && <span className="lf-foot-note lf-foot-link">Name required</span>}
                 <button className="btn crm-push" onClick={() => onDone(null)}>Skip</button>
                 <button className="btn btn-primary" disabled={busy || missing} onClick={save}>{busy ? 'Saving…' : existing ? 'Use customer' : 'Save Customer'}</button>
               </>}>
      <div style={{ overflowY: 'auto', minHeight: 0, flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignContent: 'start', padding: '14px 30px 18px' }}
           onKeyDown={(e) => { if (e.key === 's' && e.ctrlKey) { e.preventDefault(); if (!missing) save() } }}>
        {row('Mobile', <input ref={mobileRef} value={f.mobile} inputMode="tel" placeholder="Type to find the customer" onChange={(e) => { setExisting(null); set({ mobile: e.target.value }) }} />)}
        {row('Name *', <input value={f.name} onChange={(e) => set({ name: e.target.value })} />)}
        {row('WhatsApp', <input value={f.whatsapp} placeholder="Same as mobile" onChange={(e) => set({ whatsapp: e.target.value })} />)}
        {row('Email', <input type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} />)}
        {row('Date of Birth', <input type="date" value={f.dob} onChange={(e) => set({ dob: e.target.value })} />)}
        {row('Anniversary', <input type="date" value={f.anniversary} onChange={(e) => set({ anniversary: e.target.value })} />)}
        {row('Remark', <textarea rows={3} value={f.remark} onChange={(e) => set({ remark: e.target.value })} />)}
        {existing && <p className="muted-sm" style={{ margin: 0, gridColumn: '1 / -1' }}>Existing customer — their details are shown.</p>}
      </div>
    </CrmDialog>
  )
}

/* ================================================================ bill picker */

/** The bills a return can be made against: search, arrows to move, Enter to choose. */
function BillPicker({ title, bills, onClose, onPick }: {
  title: string
  bills: Array<{ id: string; number: string | null; customer_name: string; invoice_date: string; grand_total: string; src: 'invoice' | 'bill' }>
  onClose: () => void
  onPick: (bill: { id: string; number: string | null; customer_name: string; src: 'invoice' | 'bill' }) => void
}) {
  const [q, setQ] = useState('')
  const [hot, setHot] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  const needle = q.trim().toLowerCase()
  const list = bills.filter((b) => !needle || [b.number, b.customer_name].some((x) => x && x.toLowerCase().includes(needle)))
  const at = Math.min(hot, Math.max(list.length - 1, 0))
  function key(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHot(Math.min(at + 1, list.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHot(Math.max(at - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (list[at]?.number) onPick(list[at]) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
  }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(15,23,42,.45)', display: 'grid', placeItems: 'start center', paddingTop: 70 }} onKeyDown={key} onClick={onClose}>
      <div className="card" style={{ width: 'min(640px, 94vw)', maxHeight: '70vh', padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
          <b>{title}</b><span className="crm-push muted-sm">{list.length} found</span>
        </div>
        <div style={{ padding: '8px 16px' }}><input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setHot(0) }} placeholder="Type to search" aria-label="Search the bills" style={{ width: '100%' }} /></div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <table className="itl"><thead style={{ position: 'sticky', top: 0 }}><tr><th>Bill no.</th><th>Date</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
            <tbody>
              {list.map((b, n) => (
                <tr key={b.id} ref={(el) => { if (el && n === at) el.scrollIntoView({ block: 'nearest' }) }} onClick={() => b.number && onPick(b)} onMouseEnter={() => setHot(n)}
                  style={{ cursor: 'pointer', background: n === at ? 'var(--brand-soft)' : undefined }}>
                  <td><b>{b.number}</b>{!title.includes('—') && <div className="muted-sm">{b.customer_name}</div>}</td>
                  <td><DateText iso={b.invoice_date} /></td><td style={{ textAlign: 'right' }}>{rupees(b.grand_total)}</td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={3} className="muted-sm" style={{ padding: 18 }}>No bill found.</td></tr>}
            </tbody></table>
        </div>
        <div className="muted-sm" style={{ padding: '8px 16px', borderTop: '1px solid var(--border)' }}><kbd>↑</kbd><kbd>↓</kbd> Move · <kbd>Enter</kbd> Select · <kbd>Esc</kbd> Back</div>
      </div>
    </div>
  )
}
