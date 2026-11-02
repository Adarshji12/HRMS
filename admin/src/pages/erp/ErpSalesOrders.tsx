/* Sales orders and dispatch — the customer's PO, booked, released, shipped.
 *
 * The usual way in is "From quotation": an accepted CRM quotation becomes a
 * draft order line for line. When the order's value differs from that
 * quotation (or from the customer's PO value) it is flagged as a deviation and
 * cannot be submitted without saying why. */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '../../lib/useQuery'
import { useAuth } from '../../lib/auth'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconCheck, IconClose, IconEdit, IconPlus, IconSearch, IconSheet, IconTrash } from '../../components/Icons'
import { crm, todayISO } from '../crm/api'
import { CrmPage, OwnerSelect } from '../crm/parts'
import { blankPoLine, PoItems, PoSummary, priceLine, type PoLine } from './ErpPurchaseOrders'
import { erp, erpError, qtyText, rupees, type SalesOrder } from './api'
import '../../styles/so-view.css'
import {
  ChainView, DateText, DecideBar, Dialog, ErpState, Field,
  LinesTable, Money, Note, ReasonDialog, SearchSelect, Tabs, useAccess, useItems, useRun, type PickOption,
} from './parts'

const FILTERS = [
  { key: '', label: 'All' }, { key: 'draft', label: 'Draft' }, { key: 'submitted', label: 'Awaiting release' },
  { key: 'open', label: 'Open' }, { key: 'dispatched', label: 'Dispatched' }, { key: 'closed', label: 'Closed' },
  { key: 'cancelled', label: 'Cancelled' },
]

export default function ErpSalesOrders() {
  const { can, loaded } = useAccess()
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const list = useQuery(`erp-sos-${status}-${q}`, () => erp.salesOrders({ status: status || undefined, q: q.trim() || undefined }))
  const summary = useQuery('erp-sos-summary', () => erp.salesOrders({}))
  const [params, setParams] = useSearchParams()
  const [openId, setOpenId] = useState<string | null>(params.get('open'))
  const [converting, setConverting] = useState(false)
  useEffect(() => { if (params.get('open')) { setOpenId(params.get('open')); setParams({}, { replace: true }) } }, [params, setParams])
  // Opening Sales orders starts a new order, as Invoices and POs do; somebody
  // who cannot book one, or who came to open a given order, sees the list.
  const seller = can('can_manage_sales_orders')
  const [view, setView] = useState<'new' | 'list' | null>(params.get('open') ? 'list' : null)
  const [editing, setEditing] = useState<SalesOrder | null>(null)
  const [fresh, setFresh] = useState(0)
  const [saved, setSaved] = useState<string | null>(null)
  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(null), 6000)
    return () => clearTimeout(t)
  }, [saved])
  const shown = editing ? 'edit' : view ?? (loaded && seller ? 'new' : 'list')

  if (!loaded) return <CrmPage><Loading /></CrmPage>
  if ((shown === 'new' || shown === 'edit') && seller) {
    return (
      <CrmPage>
        <SalesOrderPage key={editing?.id ?? `new-${fresh}`} so={editing}
          onClose={() => { if (editing) { setEditing(null); setView('list') } else setFresh((n) => n + 1) }}
          onShowAll={() => { setEditing(null); setView('list') }}
          onSaved={(order, submitted) => {
            setEditing(null); setView('list'); list.reload(); summary.reload(); setOpenId(order.id)
            setSaved(submitted ? `${order.number} was submitted for approval.` : `${order.number} was saved as a draft. Open it any time from the Draft tab to edit or submit it.`)
          }} />
      </CrmPage>
    )
  }

  const all = summary.data ?? []
  const live = all.filter((o) => o.status !== 'cancelled')
  const value = (xs: SalesOrder[]) => xs.reduce((t, o) => t + Number(o.grand_total || 0), 0)
  const awaiting = all.filter((o) => o.status === 'submitted')
  const toDispatch = all.filter((o) => ['approved', 'partially_dispatched', 'on_hold'].includes(o.status))
  const shipped = all.filter((o) => o.status === 'dispatched')
  const drafts = all.filter((o) => o.status === 'draft')
  const cards: [string, string, string, string, string][] = [
    ['', 'Booked value', rupees(value(live)), `${live.length} orders`, 'all'],
    ['submitted', 'Awaiting release', String(awaiting.length), rupees(value(awaiting)), 'wait'],
    ['open', 'Open to dispatch', String(toDispatch.length), rupees(value(toDispatch)), 'open'],
    ['dispatched', 'Dispatched', String(shipped.length), rupees(value(shipped)), 'done'],
    ['draft', 'Drafts', String(drafts.length), 'Not yet submitted', 'draft'],
  ]
  const rows = list.data ?? []

  return (
    <CrmPage>
      <div className="vdl-kpis sol-kpis">
        {cards.map(([key, label, big, sub, tone]) => (
          <button key={label} type="button" className={`vdl-kpi sol-kpi is-${tone}${status === key ? ' is-on' : ''}`} onClick={() => setStatus(key)}>
            <span>{label}</span><b>{summary.data ? big : '—'}</b><small>{sub}</small>
          </button>
        ))}
      </div>

      <div className="crm-bar sol-bar">
        <div className="crm-search"><IconSearch size={15} />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search order no., customer or customer PO" /></div>
        {list.data && <span className="sol-count">{rows.length} {rows.length === 1 ? 'order' : 'orders'}</span>}
        {seller && (
          <div className="sol-actions">
            <button className="btn" onClick={() => setConverting(true)} title="Book an order from an accepted CRM quotation">
              <IconSheet size={15} /> From quotation
            </button>
            <button className="btn btn-primary" onClick={() => { setFresh((n) => n + 1); setView('new') }}><IconPlus size={15} /> New order</button>
          </div>
        )}
      </div>
      <div className="sol-tabs"><Tabs value={status} onChange={setStatus} items={FILTERS} /></div>
      {saved && <div className="notice notice-ok" role="status" style={{ marginBottom: 12 }}>{saved}</div>}
      {list.error && <ErrorNote>{erpError(list.cause, 'Could not load sales orders')}</ErrorNote>}

      <section className="card itl-card">
        {!list.data ? <Loading /> : rows.length === 0 ? (
          <EmptyState icon={<IconSheet size={22} />} title={q || status ? 'Nothing matches' : 'No sales orders yet'}
            body={q || status ? 'Change the search or the filter.' : 'Convert an accepted CRM quotation, or book one from the customer\u2019s PO.'} />
        ) : (
          <div className="table-wrap"><table className="itl sol">
            <thead><tr>
              <th>Sales order</th><th className="sol-c-cust">Customer</th><th>Customer PO</th><th>Ordered</th><th>Delivery</th>
              <th className="crm-num">Value</th><th className="sol-c-inv">Invoiced</th><th>Status</th><th className="itl-c-act">Actions</th>
            </tr></thead>
            <tbody>{rows.map((so) => {
              const billed = Number(so.grand_total) > 0 ? Math.min(100, Math.round((Number(so.invoiced_total || 0) / Number(so.grand_total)) * 100)) : 0
              const type = ORDER_TYPES.find(([k]) => k === so.order_type)?.[1]
              return (
                <tr key={so.id} onClick={() => setOpenId(so.id)} className={`sol-row${so.status === 'cancelled' ? ' is-off' : ''}`}>
                  <td>
                    <span className="pol-no">{so.number}</span>
                    <span className="sol-tags">
                      {type && so.order_type !== 'standard' && <em>{type}</em>}
                      {so.priority && so.priority !== 'normal' && <em className={`is-${so.priority}`}>{titleCase(so.priority)}</em>}
                      {so.has_deviation && <em className="is-dev">Deviation</em>}
                      {so.quotation_number && <small>from {so.quotation_number}</small>}
                    </span>
                  </td>
                  <td className="sol-c-cust">
                    <span className="itl-item">
                      <span className="vdl-avatar pol-avatar" aria-hidden>{so.customer_name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}</span>
                      <span className="itl-name"><b title={so.customer_name}>{so.customer_name}</b><small>{so.salesperson_name ? `by ${so.salesperson_name}` : so.place_of_supply ?? ''}</small></span>
                    </span>
                  </td>
                  <td className={so.customer_po_number ? 'sol-mono' : 'itl-muted'}>{so.customer_po_number ?? '—'}</td>
                  <td><DateText iso={so.order_date} /></td>
                  <td>{so.required_by ? <DateText iso={so.required_by} /> : <span className="itl-muted">—</span>}</td>
                  <td className="crm-num"><b className="pol-amt">{rupees(so.grand_total)}</b></td>
                  <td className="sol-c-inv">
                    <span className="pol-recv"><span className="pol-bar"><i style={{ width: `${billed}%` }} /></span><small>{billed}%</small></span>
                  </td>
                  <td><ErpState value={so.status} /></td>
                  <td className="itl-c-act" onClick={(e) => e.stopPropagation()}>
                    <div className="crm-row-actions itl-actions">
                      <button className="crm-icon-btn" title="Open" aria-label={`Open ${so.number}`} onClick={() => setOpenId(so.id)}><IconSheet size={14} /></button>
                      {so.status === 'draft' && seller && (
                        <button className="crm-icon-btn" title="Edit draft" aria-label={`Edit ${so.number}`} onClick={() => setEditing(so)}><IconEdit size={14} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}</tbody>
          </table></div>
        )}
      </section>
      {converting && <FromQuotation onClose={() => setConverting(false)} onDone={(so) => { setConverting(false); list.reload(); summary.reload(); setOpenId(so.id) }} />}
      {openId && <OrderDrawer id={openId} flash={saved} onClose={() => { setOpenId(null) }} onEdit={(so) => { setOpenId(null); setEditing(so) }} onChanged={() => { list.reload(); summary.reload() }} />}
    </CrmPage>
  )
}

const ORDER_TYPES: [string, string][] = [
  ['standard', 'Standard order'], ['project', 'Project'], ['service', 'Service'], ['amc', 'AMC / contract'], ['sample', 'Sample / demo'], ['export', 'Export'],
]
const PRIORITIES: [string, string][] = [['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']]
const DELIVERY_MODES: [string, string][] = [
  ['courier', 'Courier'], ['transport', 'Transport / lorry'], ['hand', 'Hand delivery'], ['pickup', 'Customer pickup'], ['installation', 'Delivery & installation'],
]
const FREIGHT_TERMS: [string, string][] = [['paid', 'Freight paid (by us)'], ['to_pay', 'Freight to pay (customer)'], ['included', 'Included in price']]
const OTHER = '__other__'
const NET_DAYS = { net7: 7, net15: 15, net30: 30, net45: 45, net60: 60, net90: 90 } as const
const PAY_KINDS: [string, string][] = [
  ['advance', '100% advance'], ['receipt', 'Due on receipt'],
  ['net7', 'Credit — 7 days'], ['net15', 'Credit — 15 days'], ['net30', 'Credit — 30 days'], ['net45', 'Credit — 45 days'],
  ['net60', 'Credit — 60 days'], ['net90', 'Credit — 90 days'], ['partial', 'Part advance + credit'], ['custom', 'Custom…'],
]
type Pay = { kind: string; advance: string; days: string; custom: string }

/** Payment terms are stored as words on the order; read them back into the picker. */
function parsePay(text: string): Pay {
  const t = text.trim()
  const base: Pay = { kind: 'net30', advance: '50', days: '30', custom: '' }
  if (!t) return base
  if (/^100% advance$/i.test(t) || /^advance$/i.test(t)) return { ...base, kind: 'advance' }
  if (/^due on receipt$/i.test(t)) return { ...base, kind: 'receipt' }
  const net = t.match(/^(?:net\s*)?(\d+)\s*days$/i)
  if (net && `net${net[1]}` in NET_DAYS) return { ...base, kind: `net${net[1]}` }
  const part = t.match(/^(\d{1,2})% advance, balance in (\d+) days$/i)
  if (part) return { ...base, kind: 'partial', advance: part[1], days: part[2] }
  return { ...base, kind: 'custom', custom: t }
}

function payText(p: Pay, creditDays?: number): string {
  if (p.kind === 'advance') return '100% advance'
  if (p.kind === 'receipt') return 'Due on receipt'
  if (p.kind in NET_DAYS) return `Net ${NET_DAYS[p.kind as keyof typeof NET_DAYS]} days`
  if (p.kind === 'partial') return `${p.advance || 0}% advance, balance in ${p.days || creditDays || 0} days`
  return p.custom.trim()
}
const DELIVERY_TERMS = ['Door delivery', 'FOR destination', 'Ex-works', 'Freight extra', 'Delivery & installation']
const MILESTONE_KINDS = ['advance', 'dispatch', 'delivery', 'installation', 'uat', 'monthly', 'custom']
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase())

/** Open an attachment in a new tab — a blob URL; browsers refuse data: there. */
async function openData(data: string) {
  const blob = await (await fetch(data)).blob()
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank', 'noopener')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** The sales order, as a full page: order details, items, the tax summary,
 *  delivery & terms, milestones, notes and attachments — then Save draft or
 *  Submit for approval. Editing a draft opens the same page. */
function SalesOrderPage({ so, onClose, onSaved, onShowAll }: {
  so: SalesOrder | null; onClose: () => void; onSaved: (so: SalesOrder, submitted: boolean) => void; onShowAll: () => void
}) {
  const { user } = useAuth()
  const items = useItems()
  const customers = useQuery('erp-customers-all', () => erp.customers())
  const [head, setHead] = useState({
    customer_id: so?.customer_id ?? '', site_id: so?.site_id ?? '', order_date: so?.order_date ?? todayISO(),
    order_type: so?.order_type ?? 'standard', priority: so?.priority ?? 'normal', reference: so?.reference ?? '',
    salesperson_id: so?.salesperson_id ?? user?.id ?? '',
    customer_po_number: so?.customer_po_number ?? '', customer_po_date: so?.customer_po_date ?? '', customer_po_value: so?.customer_po_value ?? '',
    required_by: so?.required_by ?? '', place_of_supply: so?.place_of_supply ?? '', payment_terms: so?.payment_terms ?? '',
    delivery_terms: so?.delivery_terms ?? '', delivery_mode: so?.delivery_mode ?? '', freight_terms: so?.freight_terms ?? '',
    transporter_name: so?.transporter_name ?? '', billing_address: so?.billing_address ?? '', shipping_address: so?.shipping_address ?? '',
    delivery_instructions: so?.delivery_instructions ?? '', freight: so?.freight && Number(so.freight) ? String(Number(so.freight)) : '',
    other_charges: so?.other_charges && Number(so.other_charges) ? String(Number(so.other_charges)) : '',
    notes: so?.notes ?? '', terms: so?.terms ?? '', internal_notes: so?.internal_notes ?? '', deviation_note: so?.deviation_note ?? '',
  })
  const [lines, setLines] = useState<PoLine[]>(so ? so.lines.map((l) => ({
    key: l.id, item_id: l.item_id ?? '', description: l.description, hsn_sac: l.hsn_sac ?? '', uom: l.uom ?? 'Nos',
    quantity: String(Number(l.quantity)), rate: String(Number(l.rate ?? 0)), discount_percent: String(Number(l.discount_percent ?? 0)),
    gst_percent: String(Number(l.gst_percent ?? 18)), requisition_line_id: null,
  })) : [blankPoLine()])
  const [milestones, setMilestones] = useState(so?.milestones.map((m) => ({ name: m.name, kind: m.kind, taxable_amount: String(Number(m.taxable_amount)), gst_percent: String(Number(m.gst_percent)), due_date: m.due_date ?? '' })) ?? [])
  const [pending, setPending] = useState<{ name: string; data: string }[]>([])
  const [kept, setKept] = useState(so?.attachments ?? [])
  const [fileError, setFileError] = useState<string | null>(null)
  /* Set once the server has the order. A later step failing (an attachment, the
     submit) must not make the next click create a second order. */
  const [stored, setStored] = useState<SalesOrder | null>(null)
  const next = useQuery(`erp-so-next-${head.order_date}`, () => erp.nextSoNumber(head.order_date || todayISO()))
  const { busy, error, run } = useRun()
  const set = (k: keyof typeof head, v: string) => setHead((h) => ({ ...h, [k]: v }))
  const fileInput = useRef<HTMLInputElement>(null)

  const all = customers.data ?? []
  const customer = all.find((c) => c.customer_id === head.customer_id) ?? null
  const account = customer?.account ?? null
  const sites = account?.sites ?? []
  const pickCustomer = (id: string) => {
    const c = all.find((x) => x.customer_id === id)
    const acc = c?.account
    setHead((h) => ({
      ...h, customer_id: id, site_id: '',
      place_of_supply: acc?.billing_state ? titleCase(acc.billing_state) : h.place_of_supply,
      billing_address: acc?.billing_address ?? '',
      // A separate shipping address on the customer means "different"; else same as billing.
      shipping_address: acc?.shipping_address && acc.shipping_address !== acc.billing_address ? acc.shipping_address : '',
    }))
    setShipMode(acc?.shipping_address && acc.shipping_address !== acc.billing_address ? 'other' : 'same')
    setShipSite('')
    if (!so) setPay(acc && acc.credit_days > 0 ? { ...parsePay(''), kind: `net${acc.credit_days}` in NET_DAYS ? `net${acc.credit_days}` : 'custom', custom: `Net ${acc.credit_days} days` } : parsePay(''))
  }
  const customerOptions: PickOption[] = all.map((c) => ({
    value: c.customer_id, label: c.customer_name,
    hint: [c.customer_code, c.contact_name, c.mobile, c.account?.gstin ?? c.crm_gstin, c.account?.billing_state && titleCase(c.account.billing_state)]
      .filter(Boolean).join(' · '),
    tag: c.account?.credit_hold ? 'Credit hold' : undefined,
  }))
  const filled = lines.filter((l) => l.item_id || l.description.trim())
  const linesBad = filled.some((l) => !(Number(l.quantity) > 0) || Number(l.rate) < 0 || !(Number(l.discount_percent || 0) <= 100))
  const datesBad = Boolean(head.required_by && head.order_date && head.required_by < head.order_date)
  // ── Delivery & terms ──
  const states = useQuery<Array<{ id: string; name: string; gst_code?: string | null; is_active: boolean }>>('crm-master-states', () => crm.masters('states'))
  const stateList = (states.data ?? []).filter((x) => x.is_active || x.name === head.place_of_supply).sort((x, y) => x.name.localeCompare(y.name))
  const vendors = useQuery('erp-vendors-all', () => erp.vendors({}))
  const transporters = (vendors.data ?? []).filter((v) => v.vendor_type === 'transporter' && v.status === 'active').map((v) => v.legal_name)
  const [transporterPick, setTransporterPick] = useState(() => (head.transporter_name ? (head.transporter_name) : ''))
  useEffect(() => {
    // An old free-text transporter that is not in the vendor master stays as "Other".
    if (vendors.data && head.transporter_name && !transporters.includes(head.transporter_name)) setTransporterPick(OTHER)
  }, [vendors.data]) // eslint-disable-line react-hooks/exhaustive-deps
  const noTransport = head.delivery_mode === 'hand' || head.delivery_mode === 'pickup'
  const [pay, setPay] = useState(() => parsePay(so?.payment_terms ?? ''))
  const paymentTerms = payText(pay, account?.credit_days)
  const [chargesRate, setChargesRate] = useState(so?.charges_gst_percent != null ? String(Number(so.charges_gst_percent)) : '')
  const autoRate = Math.max(18 * Number(!filled.length), ...filled.map((l) => Number(l.gst_percent || 0)), 0)
  const effRate = chargesRate === '' ? autoRate : Number(chargesRate)
  const charges = Number(head.freight || 0) + Number(head.other_charges || 0)
  const shipSites = sites.filter((x) => x.is_active && x.address)
  const siteAddress = (id: string) => shipSites.find((x) => x.id === id)?.address ?? ''
  const [shipMode, setShipMode] = useState<'same' | 'site' | 'other'>(() =>
    !so || !so.shipping_address || so.shipping_address === so.billing_address ? 'same' : 'other')
  const [shipSite, setShipSite] = useState('')
  const pickShip = (k: 'same' | 'site' | 'other') => {
    setShipMode(k)
    if (k === 'same') set('shipping_address', '')
    if (k === 'site') { setShipSite(''); set('shipping_address', '') }
    if (k === 'other' && head.shipping_address === head.billing_address) set('shipping_address', '')
  }
  const GST_CODES = new Map((states.data ?? []).filter((x) => x.gst_code).map((x) => [String(x.gst_code).padStart(2, '0'), x.name]))
  const gstin = account?.gstin || customer?.crm_gstin || ''
  const gstinState = /^\d{2}/.test(gstin) ? GST_CODES.get(gstin.slice(0, 2)) ?? null : null
  const inter = Boolean(next.data?.company_state && head.place_of_supply
    && next.data.company_state.trim().toLowerCase() !== head.place_of_supply.trim().toLowerCase())
  const moneyOk = (v: string) => v === '' || /^\d{1,10}(\.\d{1,2})?$/.test(v.trim())
  const freightBad = !moneyOk(head.freight)
  const otherBad = !moneyOk(head.other_charges)
  const posBad = Boolean(head.customer_id) && (!head.place_of_supply
    || (stateList.length > 0 && !stateList.some((x) => x.name.toLowerCase() === head.place_of_supply.toLowerCase())))
  const advBad = pay.kind === 'partial' && !(Number(pay.advance) >= 1 && Number(pay.advance) <= 99)
  const customPayBad = pay.kind === 'custom' && !pay.custom.trim()
  const shipBad = shipMode !== 'same' && head.shipping_address.trim().length < 5
  const total = lines.reduce((t, l) => t + priceLine(l).amount, 0) + charges + Math.round(charges * effRate) / 100
  const deviation = Boolean(so?.quotation_id) || Boolean(head.customer_po_value)
  const msUsed = milestones.filter((m) => m.name.trim() || Number(m.taxable_amount) > 0 || m.due_date)
  const msBad = (m: typeof milestones[number]) => (m.name.trim() || Number(m.taxable_amount) > 0 || m.due_date) && (
    !m.name.trim() || !moneyOk(m.taxable_amount) || !(Number(m.taxable_amount) > 0)
    || !(Number(m.gst_percent) >= 0 && Number(m.gst_percent) <= 28) || m.gst_percent.trim() === '')
  const milestonesBad = msUsed.some(msBad)
  const msTotal = msUsed.reduce((t, m) => t + Number(m.taxable_amount || 0), 0)
  const msSub = lines.reduce((t, l) => t + priceLine(l).taxable, 0) + charges
  const msOver = msUsed.length > 0 && msSub > 0 && msTotal > msSub + 0.005
  const poValueBad = !moneyOk(head.customer_po_value)
  const problem = !head.customer_id ? 'Choose a customer to begin'
    : !filled.length ? 'Add at least one item'
      : linesBad ? 'Each item needs a quantity above 0, a rate and a discount of 100 % or less'
        : datesBad ? 'The delivery date cannot be before the order date'
          : posBad ? 'Choose the place of supply'
            : advBad || customPayBad ? 'Complete the payment terms'
              : freightBad || otherBad ? 'Check the freight and other charges'
                : shipBad ? 'Enter the delivery address'
                  : poValueBad ? 'Enter the customer PO value as an amount'
                    : milestonesBad ? 'Each billing milestone needs a name, an amount above 0 and GST of 0–28 %'
                      : msOver ? 'Billing milestones add up to more than the order value'
                        : null
  const ready = !problem && !busy
  const overdue = customer && Number(customer.overdue) > 0
  const creditLimit = Number(account?.credit_limit ?? 0)
  const overLimit = creditLimit > 0 && Number(customer?.outstanding ?? 0) + total > creditLimit

  function addFiles(files: FileList | null) {
    setFileError(null)
    for (const f of Array.from(files ?? [])) {
      if (!/^image\/|^application\/pdf$/.test(f.type)) { setFileError('Attach pictures or PDFs only.'); continue }
      if (f.size > 5 * 1024 * 1024) { setFileError(`${f.name} is larger than 5 MB.`); continue }
      const reader = new FileReader()
      reader.onload = () => setPending((p) => [...p, { name: f.name, data: String(reader.result) }])
      reader.readAsDataURL(f)
    }
  }

  function save(submit = false) {
    void run(async () => {
      let saved = await erp.saveSalesOrder({
        customer_id: head.customer_id, quotation_id: so?.quotation_id ?? null, site_id: head.site_id || null,
        order_date: head.order_date || null, order_type: head.order_type, priority: head.priority, reference: head.reference || null,
        salesperson_id: head.salesperson_id || null,
        customer_po_number: head.customer_po_number || null, customer_po_date: head.customer_po_date || null,
        customer_po_value: head.customer_po_value || null, required_by: head.required_by || null,
        place_of_supply: head.place_of_supply || null, payment_terms: paymentTerms || null,
        delivery_terms: head.delivery_terms || null, delivery_mode: head.delivery_mode || null, freight_terms: head.freight_terms || null,
        transporter_name: noTransport ? null : head.transporter_name.trim() || null, billing_address: head.billing_address.trim() || null,
        shipping_address: shipMode === 'same' ? head.billing_address.trim() || null : head.shipping_address.trim() || null,
        delivery_instructions: head.delivery_instructions.trim() || null,
        freight: head.freight.trim() || '0', other_charges: head.other_charges.trim() || '0',
        charges_gst_percent: chargesRate === '' ? null : chargesRate,
        notes: head.notes || null, terms: head.terms || null, internal_notes: head.internal_notes || null,
        deviation_note: head.deviation_note || null,
        lines: filled.map((l) => ({
          item_id: l.item_id || null, description: l.description.trim() || null, hsn_sac: l.hsn_sac.trim() || null,
          uom: l.uom.trim() || null, quantity: l.quantity, rate: l.rate || '0', discount_percent: l.discount_percent || '0',
          gst_percent: l.gst_percent,
        })),
        milestones: msUsed.map((m) => ({ ...m, name: m.name.trim(), due_date: m.due_date || null })),
      }, so?.id ?? stored?.id)
      setStored(saved)
      // One at a time, so a file that fails leaves the ones before it uploaded.
      for (const f of pending) {
        saved = await erp.addSoAttachment(saved.id, f)
        setStored(saved)
        setKept(saved.attachments ?? [])
        setPending((p) => p.filter((x) => x !== f))
      }
      if (submit) {
        const draft = saved
        try {
          saved = await erp.salesOrderAction(draft.id, 'submit')
        } catch (err) {
          // The order is safe as a draft; say so, and why it did not go further.
          throw new Error(`${draft.number} is saved as a draft but was not submitted: ${erpError(err, 'the submit failed')}`)
        }
      }
      onSaved(saved, submit)
    }, submit ? 'The order could not be submitted' : 'The order could not be saved')
  }

  return (
    <div className="pof-page sof">
      <header className="pof-page-head">
        <div className="sof-title">
          <span className="sof-icon" aria-hidden><IconSheet size={18} /></span>
          <div>
            <h2>{so ? `Edit ${so.number}` : stored ? `Edit ${stored.number}` : 'New sales order'}</h2>
            <p>{so?.quotation_number ? `From quotation ${so.quotation_number} · ` : ''}Save it as a draft, or submit it straight for approval.</p>
          </div>
        </div>
        <button type="button" className="btn" onClick={onShowAll}><IconSheet size={15} /> All sales orders</button>
      </header>

      <div className="pof pof-inline">
        <section className="pof-sec">
          <header className="pof-sec-head"><h3>Order details</h3><span>Fields marked <b className="pof-req">*</b> are required</span></header>
          <div className="pof-grid">
            <div className="pof-f">
              <span className="pof-l">Sales order no.</span>
              <div className="pof-ro"><b>{so?.number ?? stored?.number ?? next.data?.number ?? '…'}</b><small>{so || stored ? 'Assigned' : 'Auto-generated'}</small></div>
            </div>
            <label className="pof-f">
              <span className="pof-l">Order date <b className="pof-req">*</b></span>
              <input type="date" value={head.order_date} max={todayISO()} onChange={(e) => set('order_date', e.target.value)} />
            </label>
            <label className="pof-f">
              <span className="pof-l">Order type</span>
              <select value={head.order_type} onChange={(e) => set('order_type', e.target.value)}>
                {ORDER_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <div className="pof-f pof-span2">
              <span className="pof-l">Customer <b className="pof-req">*</b></span>
              <SearchSelect label="Customer" value={head.customer_id} onChange={pickCustomer} options={customerOptions}
                placeholder="Search customer by name, code or GSTIN" empty="No customer matches — add one in CRM › My customers" />
            </div>
            <div className="pof-f">
              <span className="pof-l">Salesperson</span>
              <OwnerSelect value={head.salesperson_id} onChange={(v) => set('salesperson_id', v)} placeholder="— None —" />
            </div>
            {sites.length > 0 && (
              <label className="pof-f">
                <span className="pof-l">Customer site</span>
                <select value={head.site_id} onChange={(e) => set('site_id', e.target.value)}>
                  <option value="">— Main address —</option>
                  {sites.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </label>
            )}
            <div className="pof-f">
              <span className="pof-l">Priority</span>
              <div className="sof-seg" role="radiogroup" aria-label="Priority">
                {PRIORITIES.map(([k, l]) => (
                  <button key={k} type="button" role="radio" aria-checked={head.priority === k}
                    className={`${head.priority === k ? 'is-on' : ''} is-${k}`} onClick={() => set('priority', k)}>{l}</button>
                ))}
              </div>
            </div>
            <label className="pof-f">
              <span className="pof-l">Reference</span>
              <input value={head.reference} maxLength={80} onChange={(e) => set('reference', e.target.value)} placeholder="Tender / enquiry no." />
            </label>
            <div className="pof-f">
              <span className="pof-l">Status</span>
              <div className="sof-status"><ErpState value={stored?.status ?? so?.status ?? 'draft'} /></div>
            </div>
          </div>
          {customer && (
            <div className="pof-vendor">
              <span><em>GSTIN</em>{account?.gstin || customer.crm_gstin || 'Unregistered'}</span>
              <span><em>State</em>{account?.billing_state ? titleCase(account.billing_state) : '—'}</span>
              <span><em>Contact</em>{customer.contact_name}{customer.mobile ? ` · ${customer.mobile}` : ''}</span>
              <span><em>Credit</em>{creditLimit > 0 ? rupees(creditLimit) : 'No limit'} · {account?.credit_days ?? 0} days</span>
              <span className={overdue ? 'sof-bad' : ''}><em>Outstanding</em>{rupees(customer.outstanding)}{overdue ? ` · ${rupees(customer.overdue)} overdue` : ''}</span>
              {account?.credit_hold && <span className="sof-bad">On credit hold{account.hold_reason ? ` — ${account.hold_reason}` : ''}</span>}
              {overLimit && <span className="sof-bad">This order takes the customer over the credit limit</span>}
            </div>
          )}
        </section>

        <section className="pof-sec">
          <header className="pof-sec-head"><h3>Customer purchase order</h3><span>optional</span></header>
          <div className="pof-grid">
            <label className="pof-f"><span className="pof-l">Customer PO no.</span>
              <input value={head.customer_po_number} maxLength={60} onChange={(e) => set('customer_po_number', e.target.value)} placeholder="e.g. PO-4501-778" /></label>
            <label className="pof-f"><span className="pof-l">PO date</span>
              <input type="date" value={head.customer_po_date} max={todayISO()} onChange={(e) => set('customer_po_date', e.target.value)} /></label>
            <label className="pof-f"><span className="pof-l">PO value (incl. tax)</span>
              <span className={`pof-affix${poValueBad ? ' is-bad' : ''}`}><i>₹</i><input inputMode="decimal" value={head.customer_po_value} onChange={(e) => set('customer_po_value', e.target.value)} placeholder="Flags a mismatch" /></span>
                {poValueBad && <small className="pof-err">Enter an amount like 1250 or 1250.50</small>}</label>
          </div>
        </section>

        <PoItems lines={lines} onChange={setLines} items={items.data ?? []} company="" sell />

        <section className="pof-sec sdt">
          <header className="pof-sec-head">
            <h3>Delivery &amp; terms</h3>
            {head.place_of_supply && next.data?.company_state && (
              <span className={`sdt-tax${inter ? ' is-inter' : ''}`}>
                {inter ? `IGST · inter-state (${head.place_of_supply} → ${titleCase(next.data.company_state)})` : `CGST + SGST · intra-state (${head.place_of_supply})`}
              </span>
            )}
          </header>

          <div className="sdt-group">
            <h4>Supply &amp; payment</h4>
            <div className="pof-grid">
              <label className="pof-f"><span className="pof-l">Place of supply <b className="pof-req">*</b></span>
                <select value={head.place_of_supply} className={posBad ? 'is-bad' : ''} onChange={(e) => set('place_of_supply', e.target.value)}>
                  <option value="">— Select state —</option>
                  {stateList.map((st) => <option key={st.id} value={st.name}>{st.name}{st.gst_code ? ` (${st.gst_code})` : ''}</option>)}
                </select>
                {posBad ? <small className="pof-err">{head.place_of_supply ? 'Not in the States master' : 'Required — GST depends on it'}</small>
                  : gstinState && gstinState.toLowerCase() !== head.place_of_supply.toLowerCase()
                    ? <small className="sdt-note">Customer GSTIN is registered in {gstinState}</small>
                    : <small className="sdt-note">From the customer; change it for a different delivery state</small>}
              </label>
              <label className="pof-f"><span className="pof-l">Payment terms <b className="pof-req">*</b></span>
                <select value={pay.kind} onChange={(e) => setPay((p) => ({ ...p, kind: e.target.value }))}>
                  {PAY_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                {pay.kind === 'partial' && (
                  <span className="sdt-inline">
                    <span className="pof-affix sdt-mini"><input inputMode="numeric" value={pay.advance} aria-label="Advance percent"
                      className={advBad ? 'is-bad' : ''} onChange={(e) => setPay((p) => ({ ...p, advance: e.target.value.replace(/\D/g, '').slice(0, 2) }))} /><i>%</i></span>
                    <span>advance, balance in</span>
                    <span className="pof-affix sdt-mini"><input inputMode="numeric" value={pay.days} aria-label="Balance days"
                      onChange={(e) => setPay((p) => ({ ...p, days: e.target.value.replace(/\D/g, '').slice(0, 3) }))} /><i>days</i></span>
                  </span>
                )}
                {pay.kind === 'custom' && (
                  <input value={pay.custom} maxLength={160} className={`sdt-under${customPayBad ? ' is-bad' : ''}`}
                    onChange={(e) => setPay((p) => ({ ...p, custom: e.target.value }))} placeholder="e.g. 30% advance, 60% on delivery, 10% after installation" />
                )}
                {advBad && <small className="pof-err">Advance must be between 1 and 99 %</small>}
                {customPayBad && <small className="pof-err">Describe the payment terms</small>}
                {!advBad && !customPayBad && account && <small className="sdt-note">Customer's credit period: {account.credit_days} days</small>}
              </label>
              <label className="pof-f"><span className="pof-l">Delivery date</span>
                <input type="date" value={head.required_by} min={head.order_date || undefined} className={datesBad ? 'is-bad' : ''}
                  onChange={(e) => set('required_by', e.target.value)} />
                {datesBad ? <small className="pof-err">Cannot be before the order date</small> : <small className="sdt-note">Optional</small>}
              </label>
            </div>
          </div>

          <div className="sdt-group">
            <h4>Dispatch</h4>
            <div className="pof-grid pof-grid-4">
              <label className="pof-f"><span className="pof-l">Delivery mode</span>
                <select value={head.delivery_mode} onChange={(e) => set('delivery_mode', e.target.value)}>
                  <option value="">— Select —</option>{DELIVERY_MODES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select></label>
              <label className="pof-f"><span className="pof-l">Transporter</span>
                <select value={transporterPick} disabled={noTransport} onChange={(e) => {
                  const v = e.target.value
                  setTransporterPick(v)
                  set('transporter_name', v === OTHER ? '' : v)
                }}>
                  <option value="">{noTransport ? '— Not needed —' : '— Select —'}</option>
                  {transporters.map((t) => <option key={t} value={t}>{t}</option>)}
                  <option value={OTHER}>Other (type name)…</option>
                </select>
                {transporterPick === OTHER && !noTransport && (
                  <input className="sdt-under" value={head.transporter_name} maxLength={120} autoFocus
                    onChange={(e) => set('transporter_name', e.target.value)} placeholder="Transporter name" />
                )}
                {!noTransport && transporters.length === 0 && <small className="sdt-note">Add transporters in Vendor master (type: Transporter)</small>}
              </label>
              <label className="pof-f"><span className="pof-l">Delivery terms</span>
                <select value={head.delivery_terms} onChange={(e) => set('delivery_terms', e.target.value)}>
                  <option value="">— Select —</option>
                  {[...DELIVERY_TERMS, ...(head.delivery_terms && !DELIVERY_TERMS.includes(head.delivery_terms) ? [head.delivery_terms] : [])]
                    .map((t) => <option key={t} value={t}>{t}</option>)}
                </select></label>
              <label className="pof-f"><span className="pof-l">Freight terms</span>
                <select value={head.freight_terms} onChange={(e) => set('freight_terms', e.target.value)}>
                  <option value="">— Select —</option>{FREIGHT_TERMS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select></label>
            </div>
          </div>

          <div className="sdt-group">
            <h4>Charges <small>taxed with the order</small></h4>
            <div className="pof-grid">
              <label className="pof-f"><span className="pof-l">Freight charges</span>
                <span className={`pof-affix${freightBad ? ' is-bad' : ''}`}><i>₹</i><input inputMode="decimal" value={head.freight} placeholder="0.00"
                  onChange={(e) => set('freight', e.target.value)} /></span>
                {freightBad && <small className="pof-err">Enter an amount like 1250 or 1250.50</small>}</label>
              <label className="pof-f"><span className="pof-l">Other charges</span>
                <span className={`pof-affix${otherBad ? ' is-bad' : ''}`}><i>₹</i><input inputMode="decimal" value={head.other_charges} placeholder="Packing, loading…"
                  onChange={(e) => set('other_charges', e.target.value)} /></span>
                {otherBad && <small className="pof-err">Enter an amount like 1250 or 1250.50</small>}</label>
              <label className="pof-f"><span className="pof-l">GST on charges</span>
                <select value={chargesRate} onChange={(e) => setChargesRate(e.target.value)}>
                  <option value="">Auto — highest item rate ({autoRate}%)</option>
                  {['0', '5', '12', '18', '28'].map((g) => <option key={g} value={g}>{g}%</option>)}
                </select>
                <small className="sdt-note">{charges > 0 ? `${rupees(charges)} + GST ${rupees(Math.round(charges * effRate) / 100)}` : 'Applied when charges are entered'}</small></label>
            </div>
          </div>

          <div className="sdt-group">
            <h4>Addresses</h4>
            <div className="pof-grid">
              <label className="pof-f"><span className="pof-l">Billing address</span>
                <textarea rows={3} value={head.billing_address} onChange={(e) => set('billing_address', e.target.value)}
                  placeholder={customer ? 'No billing address on the customer — type it here' : 'Choose a customer first'} />
                <small className="sdt-note">{customer ? 'From the customer master — edit for this order only' : ''}</small></label>
              <div className="pof-f"><span className="pof-l">Ship to</span>
                <div className="sof-seg sdt-ship" role="radiogroup" aria-label="Ship to">
                  {([['same', 'Same as billing'], ['site', 'Customer site'], ['other', 'Different']] as const)
                    .filter(([k]) => k !== 'site' || shipSites.length > 0)
                    .map(([k, l]) => (
                      <button key={k} type="button" role="radio" aria-checked={shipMode === k} className={shipMode === k ? 'is-on' : ''}
                        onClick={() => pickShip(k)}>{l}</button>
                    ))}
                </div>
                {shipMode === 'site' && (
                  <select className="sdt-under" value={shipSite} onChange={(e) => { setShipSite(e.target.value); set('shipping_address', siteAddress(e.target.value)) }}>
                    <option value="">— Choose site —</option>
                    {shipSites.map((x) => <option key={x.id} value={x.id}>{x.name}{x.state ? ` · ${x.state}` : ''}</option>)}
                  </select>
                )}
                {shipMode === 'same'
                  ? <div className="sdt-addr">{head.billing_address || <span>Same as the billing address</span>}</div>
                  : <textarea className={`sdt-under${shipBad ? ' is-bad' : ''}`} rows={shipMode === 'site' ? 2 : 3} value={head.shipping_address}
                    onChange={(e) => set('shipping_address', e.target.value)} placeholder="Full delivery address with PIN code" />}
                {shipBad && <small className="pof-err">Enter the delivery address</small>}
              </div>
              <label className="pof-f"><span className="pof-l">Delivery instructions</span>
                <textarea rows={3} value={head.delivery_instructions} maxLength={2000} onChange={(e) => set('delivery_instructions', e.target.value)}
                  placeholder="Optional — e.g. unload at gate 2; call the site engineer before arrival" /></label>
            </div>
          </div>
        </section>

        <PoSummary lines={lines} freight={Number(head.freight || 0)} other={Number(head.other_charges || 0)}
          companyState={next.data?.company_state ?? null} vendorState={head.place_of_supply || null} vendorChosen={Boolean(head.place_of_supply)} party="place of supply"
          chargesGst={effRate} />

        <section className="pof-sec">
          <header className="pof-sec-head">
            <h3>Billing milestones</h3>
            <span>optional — advance, delivery, installation, UAT…</span>
          </header>
          {milestones.length > 0 && (
            <div className="sof-ms">
              <div className="sof-ms-head"><span>Milestone</span><span>Kind</span><span>Taxable ₹</span><span>GST %</span><span>Due</span><span /></div>
              {milestones.map((m, i) => {
                const upd = (patch: Partial<typeof m>) => setMilestones(milestones.map((x, j) => (j === i ? { ...x, ...patch } : x)))
                return (
                  <div key={i} className="sof-ms-row">
                    <input value={m.name} placeholder="e.g. 30% advance" maxLength={160} className={msBad(m) && !m.name.trim() ? 'is-bad' : ''}
                      onChange={(e) => upd({ name: e.target.value })} />
                    <select value={m.kind} onChange={(e) => upd({ kind: e.target.value })}>{MILESTONE_KINDS.map((k) => <option key={k} value={k}>{titleCase(k)}</option>)}</select>
                    <input inputMode="decimal" value={m.taxable_amount} className={msBad(m) && !(Number(m.taxable_amount) > 0 && moneyOk(m.taxable_amount)) ? 'is-bad' : ''}
                      onChange={(e) => upd({ taxable_amount: e.target.value })} />
                    <input inputMode="decimal" value={m.gst_percent} className={msBad(m) && !(Number(m.gst_percent) >= 0 && Number(m.gst_percent) <= 28 && m.gst_percent.trim() !== '') ? 'is-bad' : ''}
                      onChange={(e) => upd({ gst_percent: e.target.value })} />
                    <input type="date" value={m.due_date} onChange={(e) => upd({ due_date: e.target.value })} />
                    <button type="button" className="crm-icon-btn crm-icon-danger" aria-label="Remove milestone" onClick={() => setMilestones(milestones.filter((_, j) => j !== i))}><IconTrash size={13} /></button>
                  </div>
                )
              })}
            </div>
          )}
          {milestonesBad && <small className="pof-err">Each milestone needs a name, an amount above 0 and GST of 0–28 %.</small>}
          {!milestonesBad && msOver && <small className="pof-err">Milestones add up to {rupees(msTotal)}, more than the order's taxable value of {rupees(msSub)}.</small>}
          <button type="button" className="btn btn-sm sof-add" onClick={() => setMilestones([...milestones, { name: '', kind: 'custom', taxable_amount: '', gst_percent: '18', due_date: '' }])}>
            <IconPlus size={13} /> Add milestone
          </button>
        </section>

        <div className="sof-two">
          <section className="pof-sec">
            <header className="pof-sec-head"><h3>Notes &amp; terms</h3></header>
            <div className="sof-notes">
              <label className="pof-f"><span className="pof-l">Notes to customer</span>
                <textarea rows={2} value={head.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Printed on the order" /></label>
              <label className="pof-f"><span className="pof-l">Terms &amp; conditions</span>
                <textarea rows={2} value={head.terms} onChange={(e) => set('terms', e.target.value)} placeholder="Warranty, jurisdiction, validity…" /></label>
              <label className="pof-f"><span className="pof-l">Internal notes <small className="sof-private">not printed</small></span>
                <textarea rows={2} value={head.internal_notes} onChange={(e) => set('internal_notes', e.target.value)} placeholder="For the team only" /></label>
              {deviation && (
                <label className="pof-f"><span className="pof-l">Deviation note</span>
                  <input value={head.deviation_note} onChange={(e) => set('deviation_note', e.target.value)} placeholder="Why the order differs from the quotation / PO value" /></label>
              )}
            </div>
          </section>
          <section className="pof-sec">
            <header className="pof-sec-head"><h3>Attachments</h3><span>{kept.length + pending.length} / 10</span></header>
            <button type="button" className="sof-drop" onClick={() => fileInput.current?.click()}
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files) }}>
              <IconPlus size={16} />
              <b>Drag &amp; drop files here, or click to upload</b>
              <small>Customer PO copy, drawings, BOQ — PDF, JPG, PNG · max 5 MB each</small>
            </button>
            <input ref={fileInput} type="file" multiple accept="image/*,application/pdf" hidden onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
            {fileError && <small className="pof-err">{fileError}</small>}
            {(kept.length > 0 || pending.length > 0) && (
              <ul className="sof-files">
                {kept.map((f) => (
                  <li key={f.id}>
                    <span className="sof-file-ic"><IconSheet size={13} /></span>
                    <button type="button" className="sof-file-name" onClick={() => so && void erp.soAttachment(so.id, f.id).then((x) => openData(x.data))}>{f.name}</button>
                    <small>{f.by_name}</small>
                    <button type="button" className="crm-icon-btn crm-icon-danger" aria-label={`Remove ${f.name}`}
                      onClick={() => so && void run(async () => { const out = await erp.removeSoAttachment(so.id, f.id); setKept(out.attachments ?? []) })}><IconTrash size={12} /></button>
                  </li>
                ))}
                {pending.map((f, i) => (
                  <li key={`p${i}`} className="is-new">
                    <span className="sof-file-ic"><IconSheet size={13} /></span>
                    <button type="button" className="sof-file-name" onClick={() => void openData(f.data)}>{f.name}</button>
                    <small>Uploads on save</small>
                    <button type="button" className="crm-icon-btn crm-icon-danger" aria-label={`Remove ${f.name}`}
                      onClick={() => setPending((p) => p.filter((_, j) => j !== i))}><IconTrash size={12} /></button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <footer className="pof-page-foot">
        <span className="pof-page-total">Order total <b>{rupees(Math.round(total * 100) / 100)}</b></span>
        {error && <span className="error">{error}</span>}
        {problem ? <span className="sof-hint">{problem}</span> : <span className="sof-ok">Ready to save</span>}
        <span className="crm-push" />
        <button className="btn" disabled={busy} onClick={onClose}>{so ? 'Cancel' : 'Clear'}</button>
        <button className="btn" disabled={!ready} onClick={() => save()}>{busy ? 'Saving…' : 'Save as draft'}</button>
        <button className="btn btn-primary" disabled={!ready} onClick={() => save(true)}><IconCheck size={14} /> Submit for approval</button>
      </footer>
    </div>
  )
}

function FromQuotation({ onClose, onDone }: { onClose: () => void; onDone: (so: SalesOrder) => void }) {
  const quotes = useQuery('crm-accepted-quotes', () => crm.quotations({}))
  const accepted = (quotes.data ?? []).filter((q) => q.status === 'accepted')
  const [picked, setPicked] = useState('')
  const { busy, error, run } = useRun()
  return (
    <Dialog title="Book an order from a quotation" subtitle="Accepted quotations only. Lines, rates and tax come across unchanged." onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !picked} onClick={() => void run(async () => onDone(await erp.salesOrderFromQuotation(picked)))}>Create draft order</button>
      </>
    }>
      <div style={{ padding: '0 20px 12px', display: 'grid', gap: 6 }}>
        {quotes.data && accepted.length === 0 && <p className="crm-muted">No accepted quotations. Mark one accepted in CRM → Quotations first.</p>}
        {accepted.map((q) => (
          <label key={q.id} className="crm-check">
            <input type="radio" checked={picked === q.id} onChange={() => setPicked(q.id)} />
            <span className="crm-strong">{q.number}</span> {q.customer_name ?? q.company ?? ''} · {rupees(q.grand_total)}
          </label>
        ))}
      </div>
    </Dialog>
  )
}

/** The order opened from the list or just after saving: centred, sized to the
 *  screen, with the body scrolling between a fixed header and action bar. */
function OrderModal({ title, meta, onClose, children, footer }: {
  title: ReactNode
  meta?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = previous }
  }, [onClose])
  return (
    <div className="crm-backdrop sov-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sov" role="dialog" aria-modal="true">
        <header className="sov-head">
          <span className="sov-icon" aria-hidden><IconSheet size={18} /></span>
          <div className="sov-id">
            <h2>{title}</h2>
            {meta && <p>{meta}</p>}
          </div>
          <button className="crm-icon-btn" onClick={onClose} aria-label="Close"><IconClose size={16} /></button>
        </header>
        <div className="sov-body">{children}</div>
        {footer && <footer className="sov-foot">{footer}</footer>}
      </div>
    </div>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sov-detail">
      <dt>{label}</dt>
      <dd>{children || <span className="crm-muted">—</span>}</dd>
    </div>
  )
}

function OrderDrawer({ id, flash, onClose, onEdit, onChanged }: { id: string; flash?: string | null; onClose: () => void; onEdit: (so: SalesOrder) => void; onChanged: () => void }) {
  const navigate = useNavigate()
  const { can } = useAccess()
  const { user } = useAuth()
  const q = useQuery(`erp-so-${id}`, () => erp.salesOrder(id))
  const warehouses = useQuery('erp-wh-active', () => erp.warehouses(true))
  const { busy, error, run } = useRun(() => { q.reload(); onChanged() })
  const [prompt, setPrompt] = useState<null | { title: string; act: (reason: string) => Promise<unknown>; danger?: boolean }>(null)
  const [reserveWh, setReserveWh] = useState('')
  const [dispatching, setDispatching] = useState(false)
  const so = q.data
  if (!so) return <OrderModal title="Sales order" onClose={onClose}><Loading /></OrderModal>
  const sales = can('can_manage_sales_orders')
  const open = ['approved', 'partially_dispatched'].includes(so.status)
  const grand = Number(so.grand_total)
  const billedPct = grand > 0 ? Math.min((Number(so.invoiced_total) / grand) * 100, 100) : 0
  const typeLabel = ORDER_TYPES.find(([k]) => k === so.order_type)?.[1]
  const priority = so.priority && so.priority !== 'normal' ? titleCase(so.priority) : null

  return (
    <>
    <OrderModal
      title={<>{so.number} <ErpState value={so.status} /></>}
      meta={<>{so.customer_name}{typeLabel && <> · {typeLabel}</>}{priority && <> · <b className={`sov-prio is-${so.priority}`}>{priority} priority</b></>}</>}
      onClose={onClose}
      footer={<>
        {error && <span className="error">{error}</span>}
        <div className="sov-actions">
          {(open || so.status === 'on_hold') && can('can_approve_sales_orders') && (
            <button className="btn" onClick={() => setPrompt({ title: so.status === 'on_hold' ? 'Release hold' : 'Put on hold', act: (r) => erp.holdSalesOrder(so.id, so.status !== 'on_hold', r) })}>
              {so.status === 'on_hold' ? 'Release hold' : 'Hold'}</button>
          )}
          {['approved', 'partially_dispatched', 'dispatched', 'on_hold'].includes(so.status) && can('can_approve_sales_orders') && (
            <button className="btn" onClick={() => setPrompt({ title: `Close ${so.number}`, act: (r) => erp.salesOrderReason(so.id, 'close', r) })}>Close order</button>
          )}
          {!['cancelled', 'closed', 'dispatched', 'partially_dispatched'].includes(so.status) && sales && (
            <button className="btn btn-danger" onClick={() => setPrompt({ title: `Cancel ${so.number}`, danger: true, act: (r) => erp.salesOrderReason(so.id, 'cancel', r) })}>Cancel order</button>
          )}
        </div>
        <div className="sov-actions sov-actions-main">
          {so.status === 'draft' && sales && <>
            <button className="btn" onClick={() => onEdit(so)}>Edit</button>
            <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => erp.salesOrderAction(so.id, 'submit'))}><IconCheck size={14} /> Submit for release</button>
          </>}
          {so.status === 'rejected' && sales && <button className="btn btn-primary" onClick={() => void run(() => erp.salesOrderAction(so.id, 'revise'))}>Revise</button>}
          {so.status === 'submitted' && so.created_by !== user?.id && <DecideBar onDecide={async (a, n) => { await erp.decideSalesOrder(so.id, a, n); q.reload(); onChanged() }} />}
          {open && sales && <button className="btn" disabled={busy} onClick={() => void run(async () => {
            const req = await erp.shortageRequisition(so.id)
            navigate(`/erp/requisitions?open=${req.id}`)
          })}>Raise shortage requisition</button>}
          {open && sales && <button className="btn btn-primary" onClick={() => setDispatching(true)}>Dispatch</button>}
        </div>
      </>}
    >
      {flash && flash.startsWith(so.number) && <div className="notice notice-ok" role="status" style={{ margin: 0 }}>{flash}</div>}
      {so.has_deviation && <Note>Differs from {so.quotation_number ? `quotation ${so.quotation_number} (${rupees(so.quoted_total)})` : 'the customer PO value'}{so.deviation_note ? ` — ${so.deviation_note}` : ' — a deviation note is needed before submitting'}.</Note>}
      {so.hold_reason && <Note>On hold: {so.hold_reason}</Note>}
      {so.review_note && <Note>{so.review_note}</Note>}
      {so.closed_reason && <Note>{so.closed_reason}</Note>}

      <div className="sov-figs">
        <div className="sov-fig is-main"><span>Order value</span><b><Money value={so.grand_total} /></b><small>{rupees(so.sub_total)} + {rupees(so.tax_total)} {so.is_interstate ? 'IGST' : 'GST'}</small></div>
        <div className="sov-fig">
          <span>Invoiced</span><b><Money value={so.invoiced_total} /></b>
          <i className="sov-meter" aria-label={`${billedPct.toFixed(0)}% invoiced`}><i style={{ width: `${billedPct}%` }} /></i>
        </div>
        <div className="sov-fig"><span>Order date</span><b><DateText iso={so.order_date} /></b><small>{so.quotation_number ? `From ${so.quotation_number}` : 'Booked directly'}</small></div>
        <div className="sov-fig"><span>Required by</span><b><DateText iso={so.required_by} /></b><small>{so.delivery_mode ? titleCase(so.delivery_mode.replace(/_/g, ' ')) : 'Delivery mode not set'}</small></div>
      </div>

      <div className="sov-cols">
        <section className="sov-card">
          <h3>Order details</h3>
          <dl className="sov-details">
            <Detail label="Customer PO">{so.customer_po_number}</Detail>
            <Detail label="PO date"><DateText iso={so.customer_po_date} /></Detail>
            <Detail label="Place of supply">{so.place_of_supply ? `${so.place_of_supply}${so.is_interstate ? ' (IGST)' : ''}` : null}</Detail>
            <Detail label="Payment terms">{so.payment_terms}</Detail>
            <Detail label="Delivery terms">{so.delivery_terms}</Detail>
            <Detail label="Salesperson">{so.salesperson_name}</Detail>
            <Detail label="Booked by">{so.created_by_name}</Detail>
            <Detail label="Released by">{so.reviewed_by_name}</Detail>
          </dl>
        </section>
        <section className="sov-card">
          <h3>Delivery</h3>
          <dl className="sov-details sov-details-1">
            <Detail label="Bill to">{so.billing_address}</Detail>
            <Detail label="Ship to">{[so.site_name, so.shipping_address].filter(Boolean).join(' — ')}</Detail>
          </dl>
          {so.chain.length > 0 && <div className="sov-chain"><ChainView steps={so.chain} /></div>}
        </section>
      </div>

      <section className="sov-card">
        <div className="sov-card-head">
          <h3>Items <span className="sov-count">{so.lines.length}</span></h3>
          {open && sales && (
            <div className="sov-reserve">
              <select value={reserveWh} onChange={(e) => setReserveWh(e.target.value)} aria-label="Reserve from warehouse">
                <option value="">Reserve from…</option>{(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
              <button className="btn btn-sm" disabled={busy || !reserveWh} onClick={() => void run(() => erp.reserve(so.id, reserveWh))}>Reserve</button>
              <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => erp.salesOrderAction(so.id, 'unreserve'))}>Release</button>
            </div>
          )}
        </div>
        <LinesTable lines={so.lines} extra={[
          { head: 'Reserved', cell: (l: { reserved_qty: string }) => qtyText(l.reserved_qty) },
          { head: 'Dispatched', cell: (l: { dispatched_qty: string }) => qtyText(l.dispatched_qty) },
          { head: 'In stock', cell: (l: { available_qty: string | null }) => (l.available_qty === null ? '—' : qtyText(l.available_qty)) },
        ]} />
        <dl className="sov-totals">
          <div><dt>Sub total</dt><dd><Money value={so.sub_total} /></dd></div>
          <div><dt>{so.is_interstate ? 'IGST' : 'CGST + SGST'}</dt><dd><Money value={so.tax_total} /></dd></div>
          <div className="is-grand"><dt>Grand total</dt><dd><Money value={so.grand_total} /></dd></div>
        </dl>
      </section>

      {(so.milestones.length > 0 || so.dispatches.length > 0 || so.invoices.length > 0) && (
        <div className="sov-cols">
          {so.milestones.length > 0 && (
            <section className="sov-card">
              <h3>Billing milestones</h3>
              <ul className="sov-rows">
                {so.milestones.map((m) => (
                  <li key={m.id}>
                    <span className="sov-row-main">{m.name}<small>{titleCase(m.kind)} · {rupees(m.taxable_amount)} + {Number(m.gst_percent)}%{m.evidence ? ` · ${m.evidence}` : ''}</small></span>
                    <ErpState value={m.status} />
                    {m.status === 'pending' && sales && <button className="btn btn-sm" onClick={() => setPrompt({ title: `Mark “${m.name}” ready`, act: (r) => erp.milestoneReady(m.id, r) })}>Mark ready</button>}
                    {m.status === 'ready' && can('can_manage_billing') && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run(async () => {
                      const inv = await erp.invoiceFromMilestone(m.id)
                      navigate(`/erp/billing?open=${inv.id}`)
                    })}>Invoice</button>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {so.dispatches.length > 0 && (
            <section className="sov-card">
              <h3>Dispatches</h3>
              <ul className="sov-rows">
                {so.dispatches.map((d) => (
                  <li key={d.id}>
                    <span className="sov-row-main">{d.number}<small><DateText iso={d.dispatch_date} /> · {rupees(d.value)}</small></span>
                    <ErpState value={d.status} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {so.invoices.length > 0 && (
            <section className="sov-card">
              <h3>Invoices</h3>
              <ul className="sov-rows">
                {so.invoices.map((i) => (
                  <li key={i.id}>
                    <span className="sov-row-main">{i.number ?? 'Draft'}<small>{titleCase(i.kind)} · {rupees(i.grand_total)}</small></span>
                    <ErpState value={i.status} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </OrderModal>
    {dispatching && <DispatchForm so={so} onClose={() => setDispatching(false)} onDone={() => { setDispatching(false); q.reload(); onChanged() }} />}
    {prompt && <ReasonDialog title={prompt.title} danger={prompt.danger} onClose={() => setPrompt(null)}
      onSubmit={async (r) => { await prompt.act(r); q.reload(); onChanged() }} />}
    </>
  )
}

function DispatchForm({ so, onClose, onDone }: { so: SalesOrder; onClose: () => void; onDone: () => void }) {
  const warehouses = useQuery('erp-wh-active', () => erp.warehouses(true))
  const goods = so.lines.filter((l) => l.fulfilment !== 'service' && Number(l.pending_qty) > 0)
  const [warehouseId, setWarehouseId] = useState(goods.find((l) => l.reserved_warehouse_id)?.reserved_warehouse_id ?? '')
  const [head, setHead] = useState({ transporter: '', tracking_ref: '', vehicle_no: '', eway_bill_no: '' })
  const [rows, setRows] = useState(goods.map((l) => ({ id: l.id, quantity: l.pending_qty, serials: '' })))
  const { busy, error, run } = useRun()
  const set = (id: string, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  return (
    <Dialog wide title={`Dispatch against ${so.number}`} subtitle="Stock leaves the warehouse now. Serialised items need the exact serials picked." onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !warehouseId} onClick={() => void run(async () => {
          await erp.createDispatch({
            sales_order_id: so.id, warehouse_id: warehouseId, ...head,
            lines: rows.filter((r) => Number(r.quantity) > 0).map((r) => ({
              order_line_id: r.id, quantity: r.quantity, serials: r.serials.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
            })),
          })
          onDone()
        })}>Post dispatch</button>
      </>
    }>
      <div style={{ padding: '0 20px 12px' }}>
        <div className="crm-form" style={{ marginBottom: 12 }}>
          <Field label="From warehouse"><select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">Choose</option>{(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select></Field>
          <Field label="Transporter / courier"><input value={head.transporter} onChange={(e) => setHead({ ...head, transporter: e.target.value })} /></Field>
          <Field label="AWB / LR"><input value={head.tracking_ref} onChange={(e) => setHead({ ...head, tracking_ref: e.target.value })} /></Field>
          <Field label="Vehicle"><input value={head.vehicle_no} onChange={(e) => setHead({ ...head, vehicle_no: e.target.value })} /></Field>
          <Field label="E-way bill no."><input value={head.eway_bill_no} onChange={(e) => setHead({ ...head, eway_bill_no: e.target.value })} /></Field>
        </div>
        <div className="table-wrap"><table className="crm-lines">
          <thead><tr><th>Line</th><th className="crm-num">Pending</th><th className="crm-num">Ship now</th><th>Serials</th></tr></thead>
          <tbody>{goods.map((l) => {
            const r = rows.find((x) => x.id === l.id)!
            return (
              <tr key={l.id}>
                <td>{l.description}</td><td className="crm-num">{qtyText(l.pending_qty)}</td>
                <td className="crm-line-qty"><input inputMode="decimal" value={r.quantity} onChange={(e) => set(l.id, { quantity: e.target.value })} /></td>
                <td>{l.is_serialized ? <SerialPicker itemId={l.item_id!} warehouseId={warehouseId} value={r.serials} onChange={(v) => set(l.id, { serials: v })} /> : <span className="crm-muted">—</span>}</td>
              </tr>
            )
          })}</tbody>
        </table></div>
      </div>
    </Dialog>
  )
}

function SerialPicker({ itemId, warehouseId, value, onChange }: { itemId: string; warehouseId: string; value: string; onChange: (v: string) => void }) {
  const q = useQuery(`erp-serials-${itemId}-${warehouseId}`, () => erp.availableSerials(itemId, warehouseId), { enabled: Boolean(warehouseId) })
  const chosen = value.split(',').map((s) => s.trim()).filter(Boolean)
  const toggle = (s: string) => onChange((chosen.includes(s) ? chosen.filter((x) => x !== s) : [...chosen, s]).join(', '))
  if (!warehouseId) return <span className="crm-muted">Choose a warehouse</span>
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {(q.data ?? []).length === 0 && <span className="crm-muted">None in stock here</span>}
      {(q.data ?? []).map((s) => (
        <label key={s} className="crm-check" style={{ fontSize: 12 }}><input type="checkbox" checked={chosen.includes(s)} onChange={() => toggle(s)} />{s}</label>
      ))}
    </div>
  )
}
