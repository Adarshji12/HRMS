/* Purchase orders and goods receipts.
 *
 * A draft is edited freely; a submitted order waits on somebody other than its
 * buyer; an approved one is frozen — a change is an amendment, which bumps the
 * revision and goes back for approval. Goods are received from the order
 * itself, so a GRN can only ever be against what was ordered. */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '../../lib/useQuery'
import { useAuth } from '../../lib/auth'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconCard, IconCheck, IconClose, IconDownload, IconEdit, IconPlus, IconSearch, IconSheet, IconTrash } from '../../components/Icons'
import { CONDITIONS, erp, erpError, qtyText, rupees, type Item, type PurchaseOrder } from './api'
import {
  DateText, DecideBar, Dialog, ErpPage, ErpState, Field,
  Note, ReasonDialog, SearchSelect, useAccess, useItems, useRun,
  type PickOption,
} from './parts'
import { crm, todayISO } from '../crm/api'
import { amountInWords } from './InvoicePrint'
import { downloadCsv, downloadXlsx } from '../../lib/sheet'
import { CrmPage } from '../crm/parts'


type PoView = '' | 'pending' | 'open' | 'overdue' | 'attention'
const OPEN_STATES = ['approved', 'acknowledged', 'partially_received']
const PO_STATUS: [string, string][] = [
  ['draft', 'Draft'], ['submitted', 'Pending approval'], ['rejected', 'Rejected'], ['approved', 'Approved'],
  ['acknowledged', 'Acknowledged'], ['partially_received', 'Partly received'], ['received', 'Received'],
  ['closed', 'Closed'], ['cancelled', 'Cancelled'],
]
const poInitials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

/** Ordered vs received across the lines, as a share. */
function receivedShare(po: PurchaseOrder) {
  const ordered = po.lines.reduce((t, l) => t + Number(l.quantity || 0), 0)
  const got = po.lines.reduce((t, l) => t + Number(l.received_qty || 0), 0)
  return ordered > 0 ? Math.min(100, Math.round((got / ordered) * 100)) : 0
}

export default function ErpPurchaseOrders() {
  const { can, loaded } = useAccess()
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [vendorId, setVendorId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [card, setCard] = useState<PoView>('')
  // One load; the cards, the search and every filter work on it.
  const list = useQuery('erp-pos-all', () => erp.purchaseOrders({}))
  const [params, setParams] = useSearchParams()
  const [openId, setOpenId] = useState<string | null>(params.get('open'))
  const [editing, setEditing] = useState<PurchaseOrder | 'new' | null>(null)
  const [exporting, setExporting] = useState(false)
  const submitting = useRun(() => list.reload())
  useEffect(() => { if (params.get('open')) { setOpenId(params.get('open')); setParams({}, { replace: true }) } }, [params, setParams])
  // Opening Purchase orders starts a new PO, as Invoices does; somebody who
  // cannot raise one, or who came to open a specific PO, sees the list.
  const buyer = can('can_manage_procurement')
  const [view, setView] = useState<'new' | 'list' | null>(params.get('open') ? 'list' : null)
  const [fresh, setFresh] = useState(0)
  const shown = view ?? (loaded && buyer ? 'new' : 'list')

  if (!loaded) return <CrmPage><Loading /></CrmPage>
  if (shown === 'new' && buyer) {
    return (
      <CrmPage>
        <PoForm key={fresh} po={null} inline onClose={() => setFresh((n) => n + 1)} onShowAll={() => setView('list')}
          onSaved={(saved) => { setView('list'); list.reload(); setOpenId(saved.id) }} />
      </CrmPage>
    )
  }

  const all = list.data ?? []
  const live = all.filter((po) => po.status !== 'cancelled')
  const inCard = (po: PurchaseOrder, c: PoView) => !c
    || (c === 'pending' && po.status === 'submitted')
    || (c === 'open' && OPEN_STATES.includes(po.status))
    || (c === 'overdue' && po.is_overdue)
    || (c === 'attention' && (po.status === 'draft' || po.status === 'rejected'))
  const needle = q.trim().toLowerCase()
  const rows = all.filter((po) => inCard(po, card) && (!status || po.status === status) && (!vendorId || po.vendor_id === vendorId)
    && (!from || po.order_date >= from) && (!to || po.order_date <= to)
    && (!needle || [po.number, po.vendor_name, po.vendor_code, po.company, po.warehouse_name, ...po.lines.map((l) => l.description)]
      .some((x) => x && String(x).toLowerCase().includes(needle))))
  const vendors = [...new Map(all.map((po) => [po.vendor_id, po.vendor_name ?? '—'])).entries()].sort((x, y) => x[1].localeCompare(y[1]))
  const sum = (xs: PurchaseOrder[]) => xs.reduce((t, po) => t + Number(po.grand_total || 0), 0)
  const pending = all.filter((po) => po.status === 'submitted')
  const open = all.filter((po) => OPEN_STATES.includes(po.status))
  const overdue = all.filter((po) => po.is_overdue)
  const attention = all.filter((po) => po.status === 'draft' || po.status === 'rejected')
  const filtered = Boolean(q || status || vendorId || from || to || card)
  const clear = () => { setQ(''); setStatus(''); setVendorId(''); setFrom(''); setTo(''); setCard('') }
  const cards: [PoView, string, string, string][] = [
    ['', 'Total ordered', rupees(sum(live)), `${live.length} purchase orders`],
    ['pending', 'Pending approval', String(pending.length), rupees(sum(pending))],
    ['open', 'Open to receive', String(open.length), rupees(sum(open))],
    ['overdue', 'Overdue delivery', String(overdue.length), overdue.length ? 'Past expected date' : 'All on time'],
    ['attention', 'Drafts & rejected', String(attention.length), 'Need your action'],
  ]

  function exportRows(as: 'csv' | 'xlsx') {
    const header = ['PO number', 'Revision', 'Vendor', 'Vendor code', 'Company', 'Order date', 'Expected', 'Deliver to', 'Status',
      'Approval', 'Approved / reviewed by', 'Taxable', 'CGST', 'SGST', 'IGST', 'Freight', 'Other charges', 'Grand total', 'Received %']
    const data = rows.map((po) => [po.number, po.revision, po.vendor_name ?? '', po.vendor_code ?? '', po.company ?? '', po.order_date,
      po.committed_date ?? po.expected_date ?? '', po.warehouse_name ?? '', PO_STATUS.find(([k]) => k === po.status)?.[1] ?? po.status,
      po.status === 'submitted' ? `Waiting on ${(po.waiting_on ?? []).join(', ')}` : '', po.reviewed_by_name ?? '',
      Number(po.sub_total), Number(po.cgst ?? 0), Number(po.sgst ?? 0), Number(po.igst ?? 0), Number(po.freight), Number(po.other_charges ?? 0),
      Number(po.grand_total), receivedShare(po)])
    const name = `purchase-orders-${todayISO()}`
    if (as === 'csv') downloadCsv(`${name}.csv`, header, data)
    else downloadXlsx(`${name}.xlsx`, 'Purchase orders', header, data, [11, 12, 13, 14, 15, 16, 17])
    setExporting(false)
  }

  return (
    <ErpPage>
      <div className="vdl-kpis pol-kpis">
        {cards.map(([key, label, value, sub]) => (
          <button key={label} type="button" className={`vdl-kpi pol-kpi is-${key || 'all'}${card === key && (key || !filtered) ? ' is-on' : ''}`}
            onClick={() => { setCard((cur) => (cur === key ? '' : key)); setStatus('') }}>
            <span>{label}</span><b>{list.data ? value : '—'}</b><small>{sub}</small>
          </button>
        ))}
      </div>

      <div className="crm-bar itl-bar pol-bar">
        <div className="crm-search"><IconSearch size={15} />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search PO, vendor, item, warehouse" /></div>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setCard('') }} aria-label="Status">
          <option value="">All statuses</option>
          {PO_STATUS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} aria-label="Vendor" className="pol-vendor">
          <option value="">All vendors</option>
          {vendors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <label className="pol-date"><span>From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="pol-date"><span>To</span><input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
        {filtered && <button type="button" className="btn btn-sm" onClick={clear}>Clear</button>}
        {list.data && <span className="itl-count">{rows.length} of {all.length}</span>}
        <div className="pol-export crm-push">
          <button type="button" className="btn" disabled={!rows.length} onClick={() => setExporting((x) => !x)}><IconDownload size={15} /> Export</button>
          {exporting && (
            <div className="pol-export-menu" role="menu" onMouseLeave={() => setExporting(false)}>
              <button type="button" role="menuitem" onClick={() => exportRows('xlsx')}><b>Excel</b><small>.xlsx · {rows.length} rows</small></button>
              <button type="button" role="menuitem" onClick={() => exportRows('csv')}><b>CSV</b><small>.csv · {rows.length} rows</small></button>
            </div>
          )}
        </div>
        {buyer && <button type="button" className="btn btn-primary" onClick={() => { setFresh((n) => n + 1); setView('new') }}><IconPlus size={15} /> New PO</button>}
      </div>
      {list.error && <ErrorNote>{erpError(list.cause, 'Could not load purchase orders')}</ErrorNote>}
      {submitting.error && <div style={{ marginBottom: 10 }}><ErrorNote>{submitting.error}</ErrorNote></div>}

      <section className="card itl-card">
        {!list.data ? <Loading /> : all.length === 0 ? (
          <EmptyState icon={<IconCard size={22} />} title="No purchase orders yet" body="Raise one from scratch, an approved requisition or an awarded RFQ." />
        ) : rows.length === 0 ? (
          <EmptyState icon={<IconSearch size={22} />} title="Nothing matches" body="Change the search or the filters." />
        ) : (
          <div className="table-wrap"><table className="itl pol">
            <thead><tr>
              <th>Purchase order</th><th className="pol-c-vendor">Vendor</th><th>Ordered</th><th>Expected</th>
              <th className="pol-c-recv">Received</th><th className="crm-num">Value</th><th>Status</th><th>Approval</th><th className="itl-c-act">Actions</th>
            </tr></thead>
            <tbody>{rows.map((po) => {
              const share = receivedShare(po)
              const due = po.committed_date ?? po.expected_date
              return (
                <tr key={po.id} onClick={() => setOpenId(po.id)} className={`pol-row${po.status === 'cancelled' ? ' is-off' : ''}`}>
                  <td>
                    <span className="pol-no">{po.number}{po.revision > 0 && <em>rev {po.revision}</em>}</span>
                    <small className="pol-sub">{po.lines.length} {po.lines.length === 1 ? 'item' : 'items'}{po.company ? ` · ${po.company}` : ''}</small>
                  </td>
                  <td className="pol-c-vendor">
                    <span className="itl-item">
                      <span className="vdl-avatar pol-avatar" aria-hidden>{poInitials(po.vendor_name ?? '?')}</span>
                      <span className="itl-name"><b title={po.vendor_name ?? ''}>{po.vendor_name}</b><small>{po.vendor_code}{po.warehouse_name ? ` · to ${po.warehouse_name}` : ''}</small></span>
                    </span>
                  </td>
                  <td><DateText iso={po.order_date} /></td>
                  <td className={po.is_overdue ? 'pol-late' : ''}>
                    {due ? <DateText iso={due} /> : <span className="itl-muted">—</span>}
                    {po.is_overdue && <small>Overdue</small>}
                    {po.committed_date && !po.is_overdue && <small className="pol-sub">Committed</small>}
                  </td>
                  <td className="pol-c-recv">
                    {OPEN_STATES.includes(po.status) || po.status === 'received' || po.status === 'closed' ? (
                      <span className="pol-recv"><span className="pol-bar"><i style={{ width: `${share}%` }} /></span><small>{share}%</small></span>
                    ) : <span className="itl-muted">—</span>}
                  </td>
                  <td className="crm-num"><b className="pol-amt">{rupees(po.grand_total)}</b><small className="pol-sub">Taxable {rupees(po.sub_total)}</small></td>
                  <td><ErpState value={po.status} /></td>
                  <td className="poa-cell">{approvalLine(po)}</td>
                  <td className="itl-c-act" onClick={(e) => e.stopPropagation()}>
                    <div className="crm-row-actions itl-actions">
                      <button className="crm-icon-btn" title="Open" aria-label={`Open ${po.number}`} onClick={() => setOpenId(po.id)}><IconSheet size={14} /></button>
                      {po.status === 'draft' && buyer && <>
                        <button className="crm-icon-btn" title="Edit draft" aria-label={`Edit ${po.number}`} onClick={() => setEditing(po)}><IconEdit size={14} /></button>
                        <button className="crm-icon-btn pol-send" title="Submit for approval" aria-label={`Submit ${po.number}`} disabled={submitting.busy}
                          onClick={() => void submitting.run(() => erp.submitPurchaseOrder(po.id), 'Could not submit')}><IconCheck size={14} /></button>
                      </>}
                    </div>
                  </td>
                </tr>
              )
            })}</tbody>
          </table></div>
        )}
      </section>
      {editing && <PoForm po={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
        onSaved={(po) => { setEditing(null); list.reload(); setOpenId(po.id) }} />}
      {openId && <PoDrawer id={openId} onClose={() => setOpenId(null)} onEdit={(po) => { setOpenId(null); setEditing(po) }} onChanged={() => list.reload()} />}
    </ErpPage>
  )
}

export interface PoLine {
  key: string
  item_id: string
  description: string
  hsn_sac: string
  uom: string
  quantity: string
  rate: string
  discount_percent: string
  gst_percent: string
  requisition_line_id: string | null
}
export const blankPoLine = (): PoLine => ({
  key: Math.random().toString(36).slice(2), item_id: '', description: '', hsn_sac: '', uom: 'Nos',
  quantity: '1', rate: '', discount_percent: '', gst_percent: '18', requisition_line_id: null,
})
const PO_UNITS = ['Nos', 'Pcs', 'Box', 'Set', 'Roll', 'Mtr', 'Kg', 'Ltr', 'Pair', 'Lot', 'Hrs', 'Job']
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Quantity × rate, less the line's discount, then GST — rounded per line as
 *  the server does it. */
export function priceLine(l: PoLine) {
  const gross = r2(Number(l.quantity || 0) * Number(l.rate || 0))
  const disc = r2(gross * Number(l.discount_percent || 0) / 100)
  const taxable = r2(gross - disc)
  const gst = r2(taxable * Number(l.gst_percent || 0) / 100)
  return { gross, disc, taxable, gst, amount: r2(taxable + gst) }
}

/** The order's lines: pick from the Item Master (searchable) and the
 *  description, HSN/SAC, unit, purchase rate and GST fill themselves in;
 *  anything can still be typed over, or a line written by hand. */
export function PoItems({ lines, onChange, items, company, sell }: {
  lines: PoLine[]; onChange: (lines: PoLine[]) => void; items: Item[]; company: string
  /** A sales document: sale price and sales GST, sellable items only. */
  sell?: boolean
}) {
  const end = useRef<HTMLDivElement>(null)
  const set = (key: string, patch: Partial<PoLine>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const add = () => {
    onChange([...lines, blankPoLine()])
    setTimeout(() => end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30)
  }
  const remove = (key: string) => onChange(lines.length === 1 ? [blankPoLine()] : lines.filter((l) => l.key !== key))
  const pick = (key: string, id: string) => {
    const it = items.find((i) => i.id === id)
    if (!it) { set(key, { item_id: '' }); return }
    set(key, {
      item_id: it.id, description: it.name, hsn_sac: it.hsn_sac ?? '', uom: it.uom || 'Nos',
      rate: String(Number((sell ? it.sale_price : it.standard_cost) || 0)),
      gst_percent: String(Number(sell ? it.gst_percent ?? 18 : it.purchase_gst_percent ?? it.gst_percent ?? 18)),
    })
  }
  const options: PickOption[] = items.filter((i) => (sell ? i.can_be_sold !== false : i.can_be_purchased !== false)).map((i) => ({
    value: i.id, label: `${i.code} · ${i.name}`,
    hint: [[i.make, i.model].filter(Boolean).join(' '), i.hsn_sac && `HSN ${i.hsn_sac}`, `₹${Number((sell ? i.sale_price : i.standard_cost) || 0).toLocaleString('en-IN')} / ${i.uom}`]
      .filter(Boolean).join(' · '),
    tag: i.item_type === 'service' ? 'Service' : undefined,
  }))
  const priced = lines.map(priceLine)
  const count = lines.filter((l) => l.item_id || l.description.trim()).length

  return (
    <section className="pof-sec poi">
      <header className="pof-sec-head">
        <h3>Item details</h3>
        <span>{company ? `${company} items · ` : ''}{count} {count === 1 ? 'line' : 'lines'}</span>
      </header>
      <div className="poi-wrap">
        <table className="poi-table">
          <thead>
            <tr>
              <th className="poi-c-no">#</th><th className="poi-c-item">Item &amp; description</th><th className="poi-c-hsn">HSN/SAC</th>
              <th className="poi-c-uom">Unit</th><th className="poi-c-num">Qty</th><th className="poi-c-rate">Rate (₹)</th>
              <th className="poi-c-disc">Disc %</th><th className="poi-c-gst">GST %</th><th className="poi-c-amt">Amount (₹)</th><th className="poi-c-x" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, n) => {
              const p = priced[n]
              const qtyBad = (l.item_id || l.description.trim()) && !(Number(l.quantity) > 0)
              const discBad = Number(l.discount_percent || 0) > 100
              return (
                <tr key={l.key}>
                  <td className="poi-c-no">{n + 1}</td>
                  <td className="poi-c-item">
                    <SearchSelect label={`Item, line ${n + 1}`} value={l.item_id} onChange={(v) => pick(l.key, v)} options={options} clearable
                      placeholder="Search item…" empty={company ? `No ${company} items in the Item Master` : 'No item matches'} />
                    <input className="poi-desc" value={l.description} onChange={(e) => set(l.key, { description: e.target.value })}
                      placeholder={l.item_id ? 'Description' : 'Or type a description for a free-text line'} aria-label={`Description, line ${n + 1}`} />
                  </td>
                  <td className="poi-c-hsn"><input value={l.hsn_sac} onChange={(e) => set(l.key, { hsn_sac: e.target.value })} placeholder="—" aria-label={`HSN/SAC, line ${n + 1}`} /></td>
                  <td className="poi-c-uom">
                    <input placeholder="Nos" list="poi-units" value={l.uom} onChange={(e) => set(l.key, { uom: e.target.value })} aria-label={`Unit, line ${n + 1}`} />
                  </td>
                  <td className="poi-c-num"><input placeholder="1" inputMode="decimal" className={qtyBad ? 'is-bad' : ''} value={l.quantity}
                    onChange={(e) => set(l.key, { quantity: e.target.value })} aria-label={`Quantity, line ${n + 1}`} /></td>
                  <td className="poi-c-rate"><input inputMode="decimal" value={l.rate} placeholder="0.00"
                    onChange={(e) => set(l.key, { rate: e.target.value })} aria-label={`Rate, line ${n + 1}`} /></td>
                  <td className="poi-c-disc"><input inputMode="decimal" className={discBad ? 'is-bad' : ''} value={l.discount_percent} placeholder="0"
                    onChange={(e) => set(l.key, { discount_percent: e.target.value })} aria-label={`Discount percent, line ${n + 1}`} /></td>
                  <td className="poi-c-gst">
                    <select value={String(Number(l.gst_percent))} onChange={(e) => set(l.key, { gst_percent: e.target.value })} aria-label={`GST, line ${n + 1}`}>
                      {['0', '5', '12', '18', '28'].map((g) => <option key={g} value={g}>{g}%</option>)}
                    </select>
                  </td>
                  <td className="poi-c-amt">
                    <b>{p.amount > 0 ? rupees(p.amount) : '—'}</b>
                    {p.amount > 0 && <small>{p.disc > 0 ? `−${rupees(p.disc)} disc · ` : ''}GST {rupees(p.gst)}</small>}
                  </td>
                  <td className="poi-c-x">
                    <button type="button" className="crm-icon-btn crm-icon-danger" title="Remove item" aria-label={`Remove line ${n + 1}`}
                      onClick={() => remove(l.key)}><IconTrash size={13} /></button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <datalist id="poi-units">{PO_UNITS.map((u) => <option key={u} value={u} />)}</datalist>
        <div ref={end} />
      </div>
      <div className="poi-foot">
        <button type="button" className="btn btn-sm poi-add" onClick={add}><IconPlus size={14} /> Add item</button>
      </div>
    </section>
  )
}

/** Charges & tax summary: what the server will total, worked out as you type.
 *  GST is CGST + SGST when the vendor is in the company's state, IGST when not
 *  (an unknown state counts as the same state — the server's rule). Freight and
 *  other charges go on after tax. */
export function PoSummary({ lines, freight, other, companyState, vendorState, vendorChosen, party = 'vendor', chargesGst }: {
  lines: PoLine[]; freight: number; other: number; companyState: string | null; vendorState: string | null; vendorChosen: boolean
  party?: string
  /** When given, freight and other charges are taxable at this rate (a sales
   *  order); when not, they go on after tax (a purchase order). */
  chargesGst?: number
}) {
  const priced = lines.map(priceLine)
  const sum = (k: 'gross' | 'disc' | 'taxable' | 'gst') => r2(priced.reduce((t, p) => t + p[k], 0))
  const taxedCharges = chargesGst !== undefined
  const charges = r2((freight || 0) + (other || 0))
  const chargesTax = taxedCharges ? r2(charges * chargesGst / 100) : 0
  const gross = sum('gross')
  const disc = sum('disc')
  const taxable = r2(sum('taxable') + (taxedCharges ? charges : 0))
  const gst = r2(sum('gst') + chargesTax)
  const home = (companyState ?? '').trim().toLowerCase()
  const away = (vendorState ?? '').trim().toLowerCase()
  const inter = Boolean(home && away && home !== away)
  const cgst = inter ? 0 : r2(gst / 2)
  const sgst = inter ? 0 : r2(gst - cgst)
  const igst = inter ? gst : 0
  const grand = r2(taxable + gst + (taxedCharges ? 0 : charges))
  const words = amountInWords(grand)
  const basis = !vendorChosen ? `Choose a ${party} to fix the tax type`
    : inter ? `Inter-state · ${titleCase(away)} → ${titleCase(home)}`
      : `Intra-state · ${home ? titleCase(home) : 'same state'}`

  return (
    <section className="pof-sec pos">
      <header className="pof-sec-head">
        <h3>Charges &amp; tax summary</h3>
        <span className={`pos-basis${inter ? ' is-inter' : ''}`}>{inter ? 'IGST' : 'CGST + SGST'} · {basis}</span>
      </header>
      <div className="pos-body">
        <div className="pos-left">
          <div className="pos-words">
            <span>Amount in words</span>
            <p>{grand > 0 ? words : '—'}</p>
          </div>
          <div className="pos-tax">
            <table>
              <thead><tr><th>Tax</th><th className="crm-num">Rate</th><th className="crm-num">Taxable</th><th className="crm-num">Amount</th></tr></thead>
              <tbody>
                {taxRows(lines, priced, inter, taxedCharges && charges > 0 ? { rate: chargesGst, taxable: charges, gst: chargesTax } : undefined).map((r) => (
                  <tr key={r.key}><td>{r.label}</td><td className="crm-num">{r.rate}%</td><td className="crm-num">{rupees(r.taxable)}</td><td className="crm-num">{rupees(r.amount)}</td></tr>
                ))}
                {gst === 0 && <tr><td colSpan={4} className="pos-none">No GST on this order yet</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <dl className="pos-sum">
          <dt>Subtotal</dt><dd>{rupees(gross)}</dd>
          <dt>Total discount</dt><dd className={disc > 0 ? 'is-neg' : ''}>{disc > 0 ? `− ${rupees(disc)}` : rupees(0)}</dd>
          {taxedCharges && <>
            <dt>Freight charges</dt><dd>{rupees(freight || 0)}</dd>
            <dt>Other charges</dt><dd>{rupees(other || 0)}</dd>
          </>}
          <dt className="pos-strong">Taxable amount</dt><dd className="pos-strong">{rupees(taxable)}</dd>
          <dt className={inter ? 'is-off' : ''}>CGST</dt><dd className={inter ? 'is-off' : ''}>{rupees(cgst)}</dd>
          <dt className={inter ? 'is-off' : ''}>SGST</dt><dd className={inter ? 'is-off' : ''}>{rupees(sgst)}</dd>
          <dt className={inter ? '' : 'is-off'}>IGST</dt><dd className={inter ? '' : 'is-off'}>{rupees(igst)}</dd>
          {!taxedCharges && <>
            <dt>Freight charges</dt><dd>{rupees(freight || 0)}</dd>
            <dt>Other charges</dt><dd>{rupees(other || 0)}</dd>
          </>}
          <dt className="pos-grand">Grand total</dt><dd className="pos-grand">{rupees(grand)}</dd>
        </dl>
      </div>
    </section>
  )
}

/** GST by rate — one row per rate, split CGST/SGST or IGST. */
function taxRows(lines: PoLine[], priced: ReturnType<typeof priceLine>[], inter: boolean,
  extra?: { rate: number; taxable: number; gst: number }) {
  const by = new Map<number, { taxable: number; gst: number }>()
  if (extra && extra.gst > 0) by.set(extra.rate, { taxable: extra.taxable, gst: extra.gst })
  lines.forEach((l, n) => {
    const p = priced[n]
    if (p.gst <= 0) return
    const rate = Number(l.gst_percent || 0)
    const cur = by.get(rate) ?? { taxable: 0, gst: 0 }
    by.set(rate, { taxable: r2(cur.taxable + p.taxable), gst: r2(cur.gst + p.gst) })
  })
  return [...by.entries()].sort((a, b) => a[0] - b[0]).flatMap(([rate, v]) => {
    if (inter) return [{ key: `i${rate}`, label: 'IGST', rate: String(rate), taxable: v.taxable, amount: v.gst }]
    const half = r2(v.gst / 2)
    return [
      { key: `c${rate}`, label: 'CGST', rate: String(rate / 2), taxable: v.taxable, amount: half },
      { key: `s${rate}`, label: 'SGST', rate: String(rate / 2), taxable: v.taxable, amount: r2(v.gst - half) },
    ]
  })
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase())
const DELIVERY_TERMS = ['Door delivery', 'FOR destination', 'Ex-works', 'Freight extra', 'Courier', 'Pickup by us']
const PAY_TERMS = ['Advance', '15 days', '30 days', '45 days', '60 days', 'Against delivery']

/** A purchase order: who from, where to, when, on what terms — then the lines.
 *  The number is the series' next one, taken when the draft is first saved. */
function PoForm({ po, onClose, onSaved, inline, onShowAll }: {
  po: PurchaseOrder | null; onClose: () => void; onSaved: (po: PurchaseOrder) => void
  /** On the Purchase Orders page itself, not in a dialog. */
  inline?: boolean
  onShowAll?: () => void
}) {
  const items = useItems()
  // Every vendor, so a draft or suspended one shows why it cannot be picked.
  const vendors = useQuery('erp-vendors-all', () => erp.vendors({}))
  const warehouses = useQuery('erp-wh-active', () => erp.warehouses(true))
  const companies = useQuery<Array<{ id: string; name: string; is_active: boolean }>>(
    'crm-master-item-companies', () => crm.masters('item-companies'))
  const [head, setHead] = useState({
    vendor_id: po?.vendor_id ?? '', warehouse_id: po?.warehouse_id ?? '', expected_date: po?.expected_date ?? '',
    order_date: po?.order_date ?? todayISO(), company: po?.company ?? '',
    payment_terms: po?.payment_terms ?? '', delivery_terms: po?.delivery_terms ?? '', freight: po?.freight ?? '0',
    other_charges: po?.other_charges && Number(po.other_charges) ? String(Number(po.other_charges)) : '',
    ld_percent_per_week: po?.ld_percent_per_week ?? '0', ld_cap_percent: po?.ld_cap_percent ?? '0', notes: po?.notes ?? '',
  })
  const [lines, setLines] = useState<PoLine[]>(po ? po.lines.map((l) => ({
    key: l.id, item_id: l.item_id ?? '', description: l.description, hsn_sac: l.hsn_sac ?? '', uom: l.uom ?? 'Nos',
    quantity: String(Number(l.quantity)), rate: String(Number(l.rate ?? 0)), discount_percent: String(Number(l.discount_percent ?? 0)),
    gst_percent: String(Number(l.gst_percent ?? 18)),
    requisition_line_id: (l as { requisition_line_id?: string | null }).requisition_line_id ?? null,
  })) : [blankPoLine()])
  const next = useQuery(`erp-po-next-${head.order_date}`, () => erp.nextPoNumber(head.order_date || todayISO()))
  const { busy, error, run } = useRun()
  const set = (k: keyof typeof head, v: string) => setHead((h) => ({ ...h, [k]: v }))

  const vendor = (vendors.data ?? []).find((v) => v.id === head.vendor_id)
  const wh = (warehouses.data ?? []).find((w) => w.id === head.warehouse_id)
  const vendorOptions: PickOption[] = (vendors.data ?? [])
    .slice().sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || a.legal_name.localeCompare(b.legal_name))
    .map((v) => ({
      value: v.id, label: v.legal_name, hint: [v.code, v.gstin, v.state && titleCase(v.state)].filter(Boolean).join(' · '),
      tag: v.status === 'active' ? undefined : v.status === 'pending' ? 'Awaiting approval' : titleCase(v.status),
      disabled: v.status !== 'active' && v.id !== po?.vendor_id,
    }))
  const activeVendors = (vendors.data ?? []).filter((v) => v.status === 'active').length
  const whOptions: PickOption[] = (warehouses.data ?? []).map((w) => ({
    value: w.id, label: w.name, hint: [w.code, w.state && titleCase(w.state)].filter(Boolean).join(' · '), tag: titleCase(w.kind),
  }))
  const companyOptions: PickOption[] = (companies.data ?? []).filter((c) => c.is_active || c.name === head.company)
    .map((c) => ({ value: c.name, label: c.name }))
  // With a company chosen, the lines offer that company's items first-class.
  const itemList = (items.data ?? []).filter((i) => !head.company || (i.make ?? '').toLowerCase() === head.company.toLowerCase())
  const chargesBad = Number(head.freight || 0) < 0 || Number(head.other_charges || 0) < 0
    || Number.isNaN(Number(head.freight || 0)) || Number.isNaN(Number(head.other_charges || 0))
  const datesBad = Boolean(head.expected_date && head.order_date && head.expected_date < head.order_date)
  const filled = lines.filter((l) => l.item_id || l.description.trim())
  const linesBad = filled.some((l) => !(Number(l.quantity) > 0) || Number(l.rate) < 0 || !(Number(l.discount_percent || 0) <= 100))
  const ready = Boolean(head.vendor_id) && !datesBad && !busy && filled.length > 0 && !linesBad && !chargesBad

  function save(submit = false) {
    void run(async () => {
      const saved = await erp.savePurchaseOrder({
      ...head, company: head.company || null, other_charges: head.other_charges || '0', warehouse_id: head.warehouse_id || null, expected_date: head.expected_date || null,
      order_date: head.order_date || null, payment_terms: head.payment_terms || null, delivery_terms: head.delivery_terms || null,
      requisition_id: po?.requisition_id ?? null, sales_order_id: po?.sales_order_id ?? null,
      lines: filled.map((l) => ({
        item_id: l.item_id || null, description: l.description.trim() || null, hsn_sac: l.hsn_sac.trim() || null,
        uom: l.uom.trim() || null, quantity: l.quantity, rate: l.rate || '0', discount_percent: l.discount_percent || '0',
        gst_percent: l.gst_percent, requisition_line_id: l.requisition_line_id,
      })),
      }, po?.id)
      onSaved(submit ? await erp.submitPurchaseOrder(saved.id) : saved)
    })
  }

  const body = (
      <div className={`pof${inline ? ' pof-inline' : ''}`}>
        <section className="pof-sec">
          <header className="pof-sec-head"><h3>Basic details</h3><span>Fields marked <b className="pof-req">*</b> are required</span></header>
          <div className="pof-grid">
            <div className="pof-f">
              <span className="pof-l">PO number</span>
              <div className="pof-ro"><b>{po?.number ?? next.data?.number ?? '…'}</b><small>{po ? 'Assigned' : 'Auto-generated'}</small></div>
            </div>
            <label className="pof-f">
              <span className="pof-l">PO date <b className="pof-req">*</b></span>
              <input type="date" value={head.order_date} max={todayISO()} onChange={(e) => set('order_date', e.target.value)} />
            </label>
            <div className="pof-f">
              <span className="pof-l">Company</span>
              <SearchSelect label="Company" value={head.company} onChange={(v) => set('company', v)} options={companyOptions} clearable
                placeholder="Any company / make" empty="No companies — add them in Master › ERP Master › Company Master" />
            </div>
            <div className="pof-f pof-span2">
              <span className="pof-l">Vendor <b className="pof-req">*</b></span>
              <SearchSelect label="Vendor" value={head.vendor_id} onChange={(v) => set('vendor_id', v)} options={vendorOptions}
                placeholder={vendors.data && activeVendors === 0 ? 'No active vendor yet' : 'Search vendor by name, code or GSTIN'}
                empty="No vendor matches"
                footer={vendors.data && activeVendors < vendors.data.length
                  ? <>Only <b>active</b> vendors can be ordered from. Approve others in Master › ERP Master › Vendors.</> : undefined} />
            </div>
            <div className="pof-f">
              <span className="pof-l">Deliver to (warehouse)</span>
              <SearchSelect label="Deliver to" value={head.warehouse_id} onChange={(v) => set('warehouse_id', v)} options={whOptions} clearable
                placeholder="Choose a warehouse" empty="No active warehouse" />
            </div>
            <label className="pof-f">
              <span className="pof-l">Expected delivery date</span>
              <input type="date" value={head.expected_date} min={head.order_date || undefined} className={datesBad ? 'is-bad' : ''}
                onChange={(e) => set('expected_date', e.target.value)} />
              {datesBad && <small className="pof-err">Cannot be before the PO date</small>}
            </label>
            <label className="pof-f">
              <span className="pof-l">Payment terms</span>
              <input list="pof-pay" value={head.payment_terms} onChange={(e) => set('payment_terms', e.target.value)}
                placeholder={vendor ? `${vendor.payment_terms_days} days (vendor default)` : 'From the vendor master if blank'} />
            </label>
            <label className="pof-f">
              <span className="pof-l">Delivery terms</span>
              <input list="pof-del" value={head.delivery_terms} onChange={(e) => set('delivery_terms', e.target.value)} placeholder="e.g. Door delivery" />
            </label>
            <datalist id="pof-pay">{PAY_TERMS.map((t) => <option key={t} value={t} />)}</datalist>
            <datalist id="pof-del">{DELIVERY_TERMS.map((t) => <option key={t} value={t} />)}</datalist>
          </div>
          {vendor && (
            <div className="pof-vendor">
              <span><em>GSTIN</em>{vendor.gstin ?? '—'}</span>
              <span><em>State</em>{vendor.state ? titleCase(vendor.state) : '—'}</span>
              <span><em>Contact</em>{vendor.contact_name ?? '—'}{vendor.phone ? ` · ${vendor.phone}` : ''}</span>
              <span><em>Credit</em>{vendor.payment_terms_days} days{vendor.advance_allowed ? ' · advance OK' : ''}</span>
              {vendor.is_msme && <span className="pof-msme">MSME — pay within 45 days</span>}
              {wh && <span><em>Ship to</em>{wh.name}{wh.state ? `, ${titleCase(wh.state)}` : ''}</span>}
            </div>
          )}
        </section>

        <section className="pof-sec">
          <header className="pof-sec-head"><h3>Charges &amp; late-delivery penalty</h3></header>
          <div className="pof-grid pof-grid-4">
            <label className="pof-f"><span className="pof-l">Freight charges</span>
              <span className="pof-affix"><i>₹</i><input placeholder="0" inputMode="decimal" value={head.freight} onChange={(e) => set('freight', e.target.value)} /></span></label>
            <label className="pof-f"><span className="pof-l">Other charges</span>
              <span className="pof-affix"><i>₹</i><input inputMode="decimal" value={head.other_charges} placeholder="Packing, loading…"
                onChange={(e) => set('other_charges', e.target.value)} /></span></label>
            <label className="pof-f"><span className="pof-l">LD % per week late</span>
              <span className="pof-affix"><input placeholder="0.5" inputMode="decimal" value={head.ld_percent_per_week} onChange={(e) => set('ld_percent_per_week', e.target.value)} /><i>%</i></span></label>
            <label className="pof-f"><span className="pof-l">LD cap</span>
              <span className="pof-affix"><input placeholder="5" inputMode="decimal" value={head.ld_cap_percent} onChange={(e) => set('ld_cap_percent', e.target.value)} /><i>%</i></span></label>
          </div>
          <p className="pof-note">Liquidated damages are charged on the value received late, up to the cap.</p>
        </section>

        <PoItems lines={lines} onChange={setLines} items={itemList} company={head.company} />
        <PoSummary lines={lines} freight={Number(head.freight || 0)} other={Number(head.other_charges || 0)}
          companyState={next.data?.company_state ?? null} vendorState={vendor?.state ?? null} vendorChosen={Boolean(vendor)} />
      </div>
  )

  if (inline) {
    const total = lines.reduce((t, l) => t + priceLine(l).amount, 0) + Number(head.freight || 0) + Number(head.other_charges || 0)
    return (
      <div className="pof-page">
        <header className="pof-page-head">
          <div>
            <h2>New purchase order</h2>
            <p>Save it as a draft, or submit it straight to an approver.</p>
          </div>
          {onShowAll && <button type="button" className="btn" onClick={onShowAll}><IconSheet size={15} /> All purchase orders</button>}
        </header>
        {body}
        <footer className="pof-page-foot">
          <span className="pof-page-total">PO total <b>{rupees(r2(total))}</b></span>
          {error && <span className="error">{error}</span>}
          <span className="crm-push" />
          <button className="btn" disabled={busy} onClick={onClose}>Clear</button>
          <button className="btn" disabled={!ready} onClick={() => save()}>{busy ? 'Saving…' : 'Save as draft'}</button>
          <button className="btn btn-primary" disabled={!ready} onClick={() => save(true)} title="Saves the order and sends it to an approver">
            <IconCheck size={14} /> Submit for approval
          </button>
        </footer>
      </div>
    )
  }

  return (
    <Dialog wide title={po ? `Edit ${po.number}` : 'New purchase order'}
      subtitle={po ? `Draft · revision ${po.revision}` : 'Save it as a draft, or submit it straight to an approver.'} onClose={onClose} footer={
        <>
          {error && <span className="error">{error}</span>}
          <span className="crm-push" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={!ready} onClick={() => save()}>{busy ? 'Saving…' : 'Save as draft'}</button>
          <button className="btn btn-primary" disabled={!ready} onClick={() => save(true)}><IconCheck size={14} /> Submit for approval</button>
        </>
      }>
      {body}
    </Dialog>
  )
}

/** One line for the list: where the approval stands, and with whom. */
function approvalLine(po: PurchaseOrder) {
  if (po.status === 'draft') return <span className="poa-muted">Not submitted</span>
  if (po.status === 'submitted') {
    const who = po.waiting_on ?? []
    return <span className="poa-wait" title={who.join(', ')}>Waiting on {who.length ? who.slice(0, 2).join(', ') + (who.length > 2 ? ` +${who.length - 2}` : '') : 'an approver'}</span>
  }
  if (po.status === 'rejected') return <span className="poa-bad" title={po.review_note ?? undefined}>Rejected{po.reviewed_by_name ? ` by ${po.reviewed_by_name}` : ''}</span>
  if (po.status === 'cancelled') return <span className="poa-muted">—</span>
  return <span className="poa-ok">Approved{po.reviewed_by_name ? ` by ${po.reviewed_by_name}` : ''}</span>
}

const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null)

/** Where the order stands in approval: a status banner, who it waits on or
 *  who decided, and the timeline from raised to decided — chain rungs too. */
function PoApproval({ po, canRevise, busy, onRevise }: { po: PurchaseOrder; canRevise: boolean; busy: boolean; onRevise: () => void }) {
  const st = po.status
  const decided = !['draft', 'submitted'].includes(st) && st !== 'cancelled'
  const rejected = st === 'rejected'
  type Step = { key: string; tone: 'done' | 'now' | 'bad' | 'todo'; title: string; sub?: string | null; note?: string | null }
  const steps: Step[] = [
    { key: 'raised', tone: 'done', title: `Raised${po.created_by_name ? ` by ${po.created_by_name}` : ''}`, sub: when(po.created_at) },
    st === 'draft'
      ? { key: 'sub', tone: 'todo', title: 'Not submitted yet', sub: 'Submit it to send it for approval' }
      : { key: 'sub', tone: 'done', title: 'Submitted for approval', sub: when(po.submitted_at) },
  ]
  if (po.chain.length) {
    for (const s of po.chain) {
      steps.push({
        key: s.id,
        tone: s.status === 'approved' ? 'done' : s.status === 'rejected' ? 'bad' : s.status === 'pending' ? 'now' : 'todo',
        title: `Level ${s.level} · ${s.status === 'pending' ? 'waiting on' : s.status} ${s.acted_by_name ?? s.reviewer_name ?? s.reviewer_rule.replace(/_/g, ' ')}`,
        sub: when(s.acted_at), note: s.note,
      })
    }
  } else if (st === 'submitted') {
    steps.push({ key: 'wait', tone: 'now', title: 'Awaiting approval', sub: (po.waiting_on ?? []).length ? `Any of: ${(po.waiting_on ?? []).join(', ')}` : 'Anyone with approve-purchases permission' })
  } else if (decided) {
    steps.push({ key: 'dec', tone: rejected ? 'bad' : 'done', title: `${rejected ? 'Rejected' : 'Approved'}${po.reviewed_by_name ? ` by ${po.reviewed_by_name}` : ''}`, sub: when(po.reviewed_at), note: po.review_note })
  }
  if (st === 'cancelled') steps.push({ key: 'cx', tone: 'bad', title: 'Cancelled', note: po.closed_reason })

  const banner = st === 'draft' ? { tone: 'idle', label: 'Draft', text: 'Not yet sent for approval.' }
    : st === 'submitted' ? { tone: 'wait', label: 'Pending approval', text: (po.waiting_on ?? []).length ? `Waiting on ${(po.waiting_on ?? []).join(', ')}` : 'Waiting on an approver' }
      : rejected ? { tone: 'bad', label: 'Rejected', text: `${po.reviewed_by_name ? `${po.reviewed_by_name}: ` : ''}${po.review_note ?? 'No reason given'}` }
        : st === 'cancelled' ? { tone: 'idle', label: 'Cancelled', text: po.closed_reason ?? '' }
          : { tone: 'ok', label: 'Approved', text: `${po.reviewed_by_name ? `by ${po.reviewed_by_name}` : ''}${po.reviewed_at ? ` · ${when(po.reviewed_at)}` : ''}` }

  return (
    <section className="poa">
      <div className={`poa-banner is-${banner.tone}`}>
        <b>{banner.label}</b>
        <span>{banner.text}</span>
        {rejected && canRevise && <button className="btn btn-sm" disabled={busy} onClick={onRevise}>Revise &amp; resubmit</button>}
      </div>
      <ol className="poa-steps">
        {steps.map((s) => (
          <li key={s.key} className={`is-${s.tone}`}>
            <i aria-hidden />
            <div><b>{s.title}</b>{s.sub && <small>{s.sub}</small>}{s.note && <em>“{s.note}”</em>}</div>
          </li>
        ))}
      </ol>
    </section>
  )
}

/** A purchase order, opened: a centred view. The order itself — approval,
 *  lines, tax — on the left; terms, vendor and receipts on the right; every
 *  action in the header. */
function PoDrawer({ id, onClose, onEdit, onChanged }: { id: string; onClose: () => void; onEdit: (po: PurchaseOrder) => void; onChanged: () => void }) {
  const { can } = useAccess()
  const { user } = useAuth()
  const q = useQuery(`erp-po-${id}`, () => erp.purchaseOrder(id))
  const { busy, error, run } = useRun(() => { q.reload(); onChanged() })
  const [prompt, setPrompt] = useState<null | { title: string; action: 'amend' | 'cancel' | 'short-close' | 'waive-ld' }>(null)
  const [receiving, setReceiving] = useState(false)
  const [committed, setCommitted] = useState('')
  const nested = Boolean(prompt || receiving)
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !nested) onClose() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [nested, onClose])
  const po = q.data
  const buyer = can('can_manage_procurement')

  let head: ReactNode = <div className="pov-ident"><h2>Purchase order</h2></div>
  let tools: ReactNode = null
  let body: ReactNode = <div className="pov-loading"><Loading /></div>
  if (po) {
    const receivable = ['approved', 'acknowledged', 'partially_received'].includes(po.status)
    const share = receivedShare(po)
    const gross = po.lines.reduce((t, l) => t + Number(l.quantity || 0) * Number(l.rate || 0), 0)
    const taxable = Number(po.sub_total)
    const disc = Math.max(0, Math.round((gross - taxable) * 100) / 100)
    const inter = po.is_interstate
    head = (
      <div className="pov-ident">
        <span className="pov-kicker">Purchase order{po.company ? ` · ${po.company}` : ''}</span>
        <h2>{po.number}{po.revision > 0 && <em>rev {po.revision}</em>}<ErpState value={po.status} /></h2>
        <span className="pov-sub">{po.vendor_name} · {rupees(po.grand_total)} · <DateText iso={po.order_date} /></span>
      </div>
    )
    tools = (
      <>
        {po.status === 'draft' && buyer && <>
          <button className="btn btn-sm" onClick={() => onEdit(po)}><IconEdit size={14} /> Edit</button>
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run(() => erp.submitPurchaseOrder(po.id))}><IconCheck size={14} /> Submit for approval</button>
        </>}
        {po.status === 'submitted' && po.created_by !== user?.id && (
          <DecideBar onDecide={async (a, n) => { await erp.decidePurchaseOrder(po.id, a, n); q.reload(); onChanged() }} />
        )}
        {po.status === 'approved' && buyer && (
          <span className="pov-ack">
            <input type="date" value={committed} onChange={(e) => setCommitted(e.target.value)} title="Vendor's committed delivery date" aria-label="Committed date" />
            <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => erp.acknowledgePurchaseOrder(po.id, committed || undefined))}>Vendor acknowledged</button>
          </span>
        )}
        {receivable && can('can_manage_inventory') && <button className="btn btn-sm btn-primary" onClick={() => setReceiving(true)}>Receive goods</button>}
        {['approved', 'acknowledged'].includes(po.status) && buyer && <button className="btn btn-sm" onClick={() => setPrompt({ title: 'Amend order', action: 'amend' })}>Amend</button>}
        {po.status === 'partially_received' && buyer && <button className="btn btn-sm" onClick={() => setPrompt({ title: 'Short-close order', action: 'short-close' })}>Short-close</button>}
        {Number(po.ld_amount) > 0 && !po.ld_waived && can('can_approve_purchases') && po.created_by !== user?.id && (
          <button className="btn btn-sm" onClick={() => setPrompt({ title: 'Waive liquidated damages', action: 'waive-ld' })}>Waive LD</button>
        )}
        {['draft', 'submitted', 'approved', 'acknowledged', 'rejected'].includes(po.status) && buyer && (
          <button className="btn btn-sm pov-danger" onClick={() => setPrompt({ title: `Cancel ${po.number}`, action: 'cancel' })}>Cancel PO</button>
        )}
      </>
    )
    body = (
      <div className="pov-body">
        <main className="pov-main">
          {po.closed_reason && <Note>{po.closed_reason}</Note>}
          {po.is_overdue && <Note>Delivery is overdue.</Note>}
          <section className="pov-card"><PoApproval po={po} canRevise={buyer} busy={busy} onRevise={() => setPrompt({ title: 'Revise & resubmit', action: 'amend' })} /></section>

          <section className="pov-card pov-pad0">
            <header className="pov-card-head"><h3>Items</h3><span>{po.lines.length} {po.lines.length === 1 ? 'line' : 'lines'}{share > 0 ? ` · ${share}% received` : ''}</span></header>
            <div className="table-wrap"><table className="pov-lines">
              <thead><tr>
                <th>#</th><th>Item</th><th>HSN/SAC</th><th className="crm-num">Qty</th><th className="crm-num">Received</th>
                <th className="crm-num">Rate</th><th className="crm-num">Disc</th><th className="crm-num">GST</th><th className="crm-num">Amount</th>
              </tr></thead>
              <tbody>{po.lines.map((l, n) => {
                const got = Number(l.received_qty || 0)
                const full = got >= Number(l.quantity || 0) && got > 0
                return (
                  <tr key={l.id}>
                    <td className="pov-n">{n + 1}</td>
                    <td><b className="pov-item">{l.description}</b>{l.item_code && <small className="pov-code">{l.item_code}</small>}</td>
                    <td className="pov-mono">{l.hsn_sac ?? '—'}</td>
                    <td className="crm-num">{qtyText(l.quantity)} <small>{l.uom}</small></td>
                    <td className={`crm-num${full ? ' pov-full' : ''}`}>{got > 0 ? qtyText(l.received_qty) : '—'}</td>
                    <td className="crm-num">{rupees(l.rate ?? '0')}</td>
                    <td className="crm-num">{Number(l.discount_percent ?? 0) > 0 ? `${Number(l.discount_percent)}%` : '—'}</td>
                    <td className="crm-num">{Number(l.gst_percent ?? 0)}%</td>
                    <td className="crm-num pov-amt">{rupees(l.amount ?? '0')}</td>
                  </tr>
                )
              })}</tbody>
            </table></div>
            <div className="pov-totals">
              <div className="pov-words"><span>Amount in words</span><p>{amountInWords(Number(po.grand_total))}</p></div>
              <dl>
                <dt>Subtotal</dt><dd>{rupees(gross)}</dd>
                {disc > 0 && <><dt>Discount</dt><dd className="is-neg">− {rupees(disc)}</dd></>}
                <dt className="is-strong">Taxable amount</dt><dd className="is-strong">{rupees(po.sub_total)}</dd>
                {inter ? <><dt>IGST</dt><dd>{rupees(po.igst ?? po.tax_total)}</dd></>
                  : <><dt>CGST</dt><dd>{rupees(po.cgst ?? 0)}</dd><dt>SGST</dt><dd>{rupees(po.sgst ?? 0)}</dd></>}
                {Number(po.freight) > 0 && <><dt>Freight</dt><dd>{rupees(po.freight)}</dd></>}
                {Number(po.other_charges ?? 0) > 0 && <><dt>Other charges</dt><dd>{rupees(po.other_charges ?? 0)}</dd></>}
                <dt className="is-grand">Grand total</dt><dd className="is-grand">{rupees(po.grand_total)}</dd>
              </dl>
            </div>
          </section>

          {po.receipts.length > 0 && (
            <section className="pov-card">
              <h3 className="pov-h3">Goods receipts</h3>
              {po.receipts.map((g) => (
                <GrnRow key={g.id} grn={g} canReverse={can('can_manage_inventory')} onReversed={() => { q.reload(); onChanged() }} />
              ))}
            </section>
          )}
        </main>

        <aside className="pov-side">
          <section className="pov-card">
            <h3 className="pov-h3">Vendor</h3>
            <div className="pov-vendor">
              <span className="vdl-avatar" aria-hidden>{poInitials(po.vendor_name ?? '?')}</span>
              <div><b>{po.vendor_name}</b><small>{po.vendor_code}</small></div>
            </div>
            <span className={`pov-tax${inter ? ' is-inter' : ''}`}>{inter ? 'Inter-state · IGST' : 'Intra-state · CGST + SGST'}</span>
          </section>
          <section className="pov-card">
            <h3 className="pov-h3">Order details</h3>
            <dl className="pov-kv">
              <dt>PO date</dt><dd><DateText iso={po.order_date} /></dd>
              <dt>Expected</dt><dd className={po.is_overdue ? 'is-bad' : ''}>{po.expected_date ? <DateText iso={po.expected_date} /> : '—'}</dd>
              <dt>Vendor committed</dt><dd>{po.committed_date ? <DateText iso={po.committed_date} /> : '—'}</dd>
              <dt>Deliver to</dt><dd>{po.warehouse_name ?? '—'}</dd>
              <dt>Payment terms</dt><dd>{po.payment_terms ?? '—'}</dd>
              <dt>Delivery terms</dt><dd>{po.delivery_terms ?? '—'}</dd>
              <dt>Raised by</dt><dd>{po.created_by_name ?? '—'}</dd>
            </dl>
          </section>
          {(Number(po.ld_percent_per_week) > 0 || Number(po.ld_amount) > 0) && (
            <section className="pov-card">
              <h3 className="pov-h3">Late-delivery penalty</h3>
              <dl className="pov-kv">
                <dt>LD rate</dt><dd>{Number(po.ld_percent_per_week)}% / week</dd>
                <dt>LD cap</dt><dd>{Number(po.ld_cap_percent)}%</dd>
                <dt>Accrued</dt><dd className={Number(po.ld_amount) > 0 ? 'is-bad' : ''}>{rupees(po.ld_amount)}{po.ld_waived ? ' (waived)' : ''}</dd>
              </dl>
            </section>
          )}
          {po.notes && <section className="pov-card"><h3 className="pov-h3">Notes</h3><p className="pov-notes">{po.notes}</p></section>}
        </aside>
      </div>
    )
  }

  return (
    <div className="pov-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !nested && onClose()}>
      <div className="pov" role="dialog" aria-modal="true" aria-label={po?.number ?? 'Purchase order'}>
        <header className="pov-head">
          {head}
          <div className="pov-tools">{tools}</div>
          <button className="crm-icon-btn pov-close" onClick={onClose} aria-label="Close"><IconClose size={16} /></button>
        </header>
        {error && <div className="pov-error"><ErrorNote>{error}</ErrorNote></div>}
        {body}
      </div>
      {po && receiving && <ReceiveForm po={po} onClose={() => setReceiving(false)} onDone={() => { setReceiving(false); q.reload(); onChanged() }} />}
      {po && prompt && <ReasonDialog title={prompt.title} danger={prompt.action === 'cancel'} onClose={() => setPrompt(null)}
        onSubmit={async (reason) => { await erp.purchaseOrderReason(po.id, prompt.action, reason); q.reload(); onChanged() }} />}
    </div>
  )
}

/** One goods receipt against the order. */
function GrnRow({ grn, canReverse, onReversed }: { grn: PurchaseOrder['receipts'][number]; canReverse: boolean; onReversed: () => void }) {
  const [reversing, setReversing] = useState(false)
  return (
    <div className="pov-grn">
      <span className="crm-strong pov-mono">{grn.number}</span>
      <DateText iso={grn.received_on} />
      {grn.days_late > 0 && <span className="crm-sub">{grn.days_late} days late · LD {rupees(grn.ld_amount)}</span>}
      <span className="crm-push"><ErpState value={grn.status} /></span>
      {canReverse && grn.status === 'posted' && <button className="btn btn-sm" onClick={() => setReversing(true)}>Reverse</button>}
      {reversing && <ReasonDialog title={`Reverse ${grn.number}`} danger hint="The stock leaves the warehouse again. Refused if it has already moved on."
        onClose={() => setReversing(false)} onSubmit={async (r) => { await erp.reverseGoodsReceipt(grn.id, r); onReversed() }} />}
    </div>
  )
}

function ReceiveForm({ po, onClose, onDone }: { po: PurchaseOrder; onClose: () => void; onDone: () => void }) {
  const warehouses = useQuery('erp-wh-active', () => erp.warehouses(true))
  const [warehouseId, setWarehouseId] = useState(po.warehouse_id ?? '')
  const [challan, setChallan] = useState('')
  const [invoiceRef, setInvoiceRef] = useState('')
  const pending = po.lines.filter((l) => Number(l.pending_qty) > 0)
  const [rows, setRows] = useState(pending.map((l) => ({ id: l.id, received: l.pending_qty, rejected: '0', condition: 'good', serials: '' })))
  const { busy, error, run } = useRun()
  const set = (id: string, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  return (
    <Dialog wide title={`Receive against ${po.number}`} subtitle="Rejected units are recorded, not stocked. Serialised items need one serial per accepted unit." onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !warehouseId} onClick={() => void run(async () => {
          await erp.postGoodsReceipt({
            purchase_order_id: po.id, warehouse_id: warehouseId, challan_ref: challan, invoice_ref: invoiceRef,
            lines: rows.filter((r) => Number(r.received) > 0).map((r) => ({
              po_line_id: r.id, received_qty: r.received, rejected_qty: r.rejected || '0', condition: r.condition,
              serials: r.serials.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
            })),
          })
          onDone()
        })}>Post GRN</button>
      </>
    }>
      <div style={{ padding: '0 20px 12px' }}>
        <div className="crm-form" style={{ marginBottom: 12 }}>
          <Field label="Into warehouse">
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">Choose</option>{(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          <Field label="Delivery challan"><input placeholder="e.g. DC-1042" value={challan} onChange={(e) => setChallan(e.target.value)} /></Field>
          <Field label="Vendor invoice"><input placeholder="e.g. INV/24-25/0731" value={invoiceRef} onChange={(e) => setInvoiceRef(e.target.value)} /></Field>
        </div>
        <div className="table-wrap"><table className="crm-lines">
          <thead><tr><th>Line</th><th className="crm-num">Due</th><th className="crm-num">Received</th><th className="crm-num">Rejected</th><th>Condition</th><th>Serials</th></tr></thead>
          <tbody>{pending.map((l) => {
            const r = rows.find((x) => x.id === l.id)!
            return (
              <tr key={l.id}>
                <td>{l.description}</td><td className="crm-num">{qtyText(l.pending_qty)}</td>
                <td className="crm-line-qty"><input placeholder="0" inputMode="decimal" value={r.received} onChange={(e) => set(l.id, { received: e.target.value })} /></td>
                <td className="crm-line-qty"><input placeholder="0" inputMode="decimal" value={r.rejected} onChange={(e) => set(l.id, { rejected: e.target.value })} /></td>
                <td><select value={r.condition} onChange={(e) => set(l.id, { condition: e.target.value })}>{CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}</select></td>
                <td>{l.is_serialized ? <textarea rows={2} value={r.serials} placeholder="One per line or comma-separated" onChange={(e) => set(l.id, { serials: e.target.value })} /> : <span className="crm-muted">—</span>}</td>
              </tr>
            )
          })}</tbody>
        </table></div>
      </div>
    </Dialog>
  )
}
